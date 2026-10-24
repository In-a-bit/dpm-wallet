import { Inject, Injectable } from "@nestjs/common";
import {
  Between,
  LessThan,
  LessThanOrEqual,
  MoreThanOrEqual,
  type FindOperator,
  type FindOptionsWhere,
  type Repository,
} from "typeorm";

import { DB } from "../../tokens";
import type { Db, Executor } from "../client";
import { AuditEventEntity } from "../entities";
import { AuditAction } from "../../observability/audit-action";

/**
 * The one definition of routine: a successful run of one of these actions. Everything else
 * (vault, address, withdraw, any failure) is an important record that only an operator-confirmed
 * archive may delete. Purge and export both build on this, so they can never disagree.
 */
export const ROUTINE_AUDIT_ACTIONS: readonly string[] = [
  AuditAction.SignOrder,
  AuditAction.SignCancel,
  AuditAction.MetaAllowance,
  AuditAction.MetaRedeem,
  AuditAction.MetaSplit,
  AuditAction.MetaMerge,
];

const ROUTINE_SQL = "(action = ANY($1) AND outcome = 'success')";

export type ArchiveScope = {
  before: string;
  maxId: number;
};

export type AuditExportQuery = ArchiveScope & {
  /** Exclusive: only rows with a greater id. */
  afterId?: number;
  limit: number;
};

export type AuditScope = {
  maxId: number;
  rows: number;
};

export type AuditOutcome = "success" | "failure";

export type AuditEvent = {
  id: number;
  ref: string | null;
  action: string;
  outcome: AuditOutcome;
  detail: unknown;
  createdAt: string;
};

export type NewAuditEvent = {
  ref?: string | null;
  action: string;
  outcome: AuditOutcome;
  detail?: unknown;
  createdAt: string;
};

export type AuditQuery = {
  ref?: string;
  action?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
  /** Keyset mode: only rows with a smaller id. Ignores `offset` and skips the count. */
  beforeId?: number;
};

export type AuditPage = {
  events: AuditEvent[];
  /** Absent in keyset mode, where counting every matching row would defeat the point. */
  total?: number;
  /** Id of the last event when more rows follow, otherwise null. */
  nextId: number | null;
};

@Injectable()
export class AuditRepository {
  private readonly events: Repository<AuditEventEntity>;

  constructor(@Inject(DB) private readonly db: Db) {
    this.events = db.getRepository(AuditEventEntity);
  }

  async record(event: NewAuditEvent, executor: Executor = this.db.manager): Promise<void> {
    await executor.insert(AuditEventEntity, {
      ref: event.ref ?? null,
      action: event.action,
      outcome: event.outcome,
      detail: event.detail === undefined ? null : JSON.stringify(event.detail),
      createdAt: event.createdAt,
    });
  }

  async query(query: AuditQuery): Promise<AuditPage> {
    if (query.beforeId !== undefined) return this.queryAfterCursor(query, query.beforeId);

    const [rows, total] = await this.events.findAndCount({
      where: buildWhere(query),
      order: { id: "DESC" },
      take: query.limit,
      skip: query.offset,
    });
    const more = query.offset + rows.length < total;
    return {
      events: rows.map(toAuditEvent),
      total,
      nextId: more ? (rows.at(-1)?.id ?? null) : null,
    };
  }

  /** One extra row tells whether another page exists without a second query. */
  private async queryAfterCursor(query: AuditQuery, beforeId: number): Promise<AuditPage> {
    const rows = await this.events.find({
      where: { ...buildWhere(query), id: LessThan(beforeId) },
      order: { id: "DESC" },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      events: page.map(toAuditEvent),
      nextId: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Whether building `amount` more would take the successful withdrawals recorded since
   * `since` past `cap`. Summed in SQL (numeric) so no float ever touches an amount; rows
   * recorded without an `amountDecimal` are ignored.
   */
  async withdrawalWouldExceed(
    since: string,
    amount: string,
    cap: string,
    executor: Executor = this.db.manager,
  ): Promise<{ exceeded: boolean; used: string }> {
    const rows: { used: string; exceeded: boolean }[] = await executor.query(
      `WITH used AS (
         SELECT COALESCE(SUM((detail::jsonb ->> 'amountDecimal')::numeric), 0) AS total
         FROM audit_events
         WHERE action = $1 AND outcome = 'success' AND created_at >= $2
       )
       SELECT total::text AS used, total + $3::numeric > $4::numeric AS exceeded FROM used`,
      [AuditAction.MetaWithdraw, since, amount, cap],
    );
    return { exceeded: rows[0]?.exceeded === true, used: rows[0]?.used ?? "0" };
  }

  /** Deletes one batch of routine success rows older than `before`; returns how many went. */
  async purgeRoutine(before: string, batch: number): Promise<number> {
    return this.deleteBatch(ROUTINE_SQL, [before, batch], "created_at < $2", "$3");
  }

  /** Important rows (not routine success) inside the archive scope, by ascending id. */
  async exportImportant(query: AuditExportQuery): Promise<AuditEvent[]> {
    const rows = await this.events
      .createQueryBuilder("e")
      .where("NOT (e.action IN (:...routine) AND e.outcome = 'success')", {
        routine: ROUTINE_AUDIT_ACTIONS,
      })
      .andWhere("e.createdAt < :before AND e.id <= :maxId", query)
      .andWhere("e.id > :afterId", { afterId: query.afterId ?? 0 })
      .orderBy("e.id", "ASC")
      .limit(query.limit)
      .getMany();
    return rows.map(toAuditEvent);
  }

  /** Deletes one batch of exactly the rows `exportImportant` would return. */
  async deleteArchived(scope: ArchiveScope, batch: number): Promise<number> {
    return this.deleteBatch(
      `NOT ${ROUTINE_SQL}`,
      [scope.before, scope.maxId, batch],
      "created_at < $2 AND id <= $3",
      "$4",
    );
  }

  /** What an archive would cover right now; rows inserted later have a greater id. */
  async importantScope(before: string): Promise<AuditScope> {
    const [row] = await this.db.query<{ max_id: string; rows: string }[]>(
      `SELECT COALESCE(MAX(id), 0) AS max_id, COUNT(*) AS rows FROM audit_events
       WHERE NOT ${ROUTINE_SQL} AND created_at < $2`,
      [ROUTINE_AUDIT_ACTIONS, before],
    );
    return { maxId: Number(row?.max_id ?? 0), rows: Number(row?.rows ?? 0) };
  }

  private async deleteBatch(
    predicate: string,
    rest: unknown[],
    bounds: string,
    limitParam: string,
  ): Promise<number> {
    const [row] = await this.db.query<{ n: number }[]>(
      `WITH d AS (
         DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events WHERE ${predicate} AND ${bounds} ORDER BY id LIMIT ${limitParam}
         ) RETURNING 1
       ) SELECT COUNT(*)::int AS n FROM d`,
      [ROUTINE_AUDIT_ACTIONS, ...rest],
    );
    return row?.n ?? 0;
  }
}

/**
 * Only the filters the caller actually supplied are set. An absent one has to be left off the
 * object rather than passed as `undefined`, which TypeORM rejects — a guard against the far
 * worse alternative of a typo silently widening a query to every row.
 */
function buildWhere(query: AuditQuery): FindOptionsWhere<AuditEventEntity> {
  const where: FindOptionsWhere<AuditEventEntity> = {};
  if (query.ref) where.ref = query.ref;
  if (query.action) where.action = query.action;

  const createdAt = buildCreatedAtRange(query.from, query.to);
  if (createdAt) where.createdAt = createdAt;
  return where;
}

/** Both bounds are inclusive, matching the half-open-free `from`/`to` the API documents. */
function buildCreatedAtRange(
  from: string | undefined,
  to: string | undefined,
): FindOperator<string> | undefined {
  if (from && to) return Between(from, to);
  if (from) return MoreThanOrEqual(from);
  if (to) return LessThanOrEqual(to);
  return undefined;
}

function toAuditEvent(row: AuditEventEntity): AuditEvent {
  return {
    id: row.id,
    ref: row.ref,
    action: row.action,
    outcome: row.outcome as AuditOutcome,
    detail: row.detail === null ? null : safeParse(row.detail),
    createdAt: row.createdAt,
  };
}

/** Detail is written as JSON by this service, but a hand-edited row must not break reads. */
function safeParse(detail: string): unknown {
  try {
    return JSON.parse(detail);
  } catch {
    return detail;
  }
}
