import type {
  AuditOutcome,
  AuditPage,
  AuditQuery,
  AuditRepository,
} from "../db/repositories/audit.repo.js";
import type { AuditAction } from "./audit-action.js";
import { logInfo, redact } from "./log.js";

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
export class AuditLog {
  constructor(
    private readonly repository: AuditRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  record(entry: AuditEntry): void {
    const detail = entry.detail ? (redact(entry.detail) as Record<string, unknown>) : undefined;
    this.repository.record({
      ref: entry.ref ?? null,
      action: entry.action,
      outcome: entry.outcome,
      ...(detail ? { detail } : {}),
      createdAt: this.now(),
    });
    logInfo(entry.action, { ref: entry.ref ?? undefined, outcome: entry.outcome, ...detail });
  }

  query(query: AuditQuery): AuditPage {
    return this.repository.query(query);
  }
}
