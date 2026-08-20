import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import type { Db } from "../client.js";
import { auditEvents, type AuditEventRow } from "../schema.js";

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

export class AuditRepository {
  constructor(private readonly db: Db) {}

  record(event: NewAuditEvent): void {
    this.db
      .insert(auditEvents)
      .values({
        ref: event.ref ?? null,
        action: event.action,
        outcome: event.outcome,
        detail: event.detail === undefined ? null : JSON.stringify(event.detail),
        createdAt: event.createdAt,
      })
      .run();
  }

  query(query: AuditQuery): AuditPage {
    const filter = buildFilter(query);
    const rows = this.db
      .select()
      .from(auditEvents)
      .where(filter)
      .orderBy(desc(auditEvents.id))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    return { events: rows.map(toAuditEvent), total: this.countMatches(filter) };
  }

  private countMatches(filter: SQL | undefined): number {
    const [row] = this.db
      .select({ total: sql<number>`COUNT(*)` })
      .from(auditEvents)
      .where(filter)
      .all();
    return row?.total ?? 0;
  }
}

function buildFilter(query: AuditQuery): SQL | undefined {
  const conditions = [
    query.ref ? eq(auditEvents.ref, query.ref) : undefined,
    query.action ? eq(auditEvents.action, query.action) : undefined,
    query.from ? gte(auditEvents.createdAt, query.from) : undefined,
    query.to ? lte(auditEvents.createdAt, query.to) : undefined,
  ].filter((condition): condition is SQL => condition !== undefined);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    ref: row.ref ?? null,
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
