import { Injectable } from "@nestjs/common";

import {
  AuditRepository,
  type AuditOutcome,
  type AuditPage,
  type AuditQuery,
} from "../db/repositories/audit.repo";
import type { AuditAction } from "./audit-action";
import { logInfo, redact } from "./log";

export type AuditEntry = {
  ref?: string | null;
  action: AuditAction;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
};

/**
 * Writes the audit trail to both the database (queryable by the operator) and stdout (for
 * whatever log pipeline the operator runs). Detail passes through the same redaction the
 * logger uses, so a signature or credential cannot reach the stored row either.
 */
@Injectable()
export class AuditLog {
  constructor(private readonly repository: AuditRepository) {}

  record(entry: AuditEntry): void {
    const detail = entry.detail ? (redact(entry.detail) as Record<string, unknown>) : undefined;
    this.repository.record({
      ref: entry.ref ?? null,
      action: entry.action,
      outcome: entry.outcome,
      ...(detail ? { detail } : {}),
      createdAt: new Date().toISOString(),
    });
    logInfo(entry.action, { ref: entry.ref ?? undefined, outcome: entry.outcome, ...detail });
  }

  query(query: AuditQuery): AuditPage {
    return this.repository.query(query);
  }
}
