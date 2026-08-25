import { Inject, Injectable } from "@nestjs/common";
import {
  Between,
  LessThanOrEqual,
  MoreThanOrEqual,
  type FindOperator,
  type FindOptionsWhere,
  type Repository,
} from "typeorm";

import { DB } from "../../tokens";
import type { Db, Executor } from "../client";
import { AuditEventEntity } from "../entities";

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
};

export type AuditPage = {
  events: AuditEvent[];
  total: number;
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
    const [rows, total] = await this.events.findAndCount({
      where: buildWhere(query),
      order: { id: "DESC" },
      take: query.limit,
      skip: query.offset,
    });
    return { events: rows.map(toAuditEvent), total };
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
