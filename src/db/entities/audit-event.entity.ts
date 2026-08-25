import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/**
 * The one audit trail: every signing action and address creation, each written exactly once
 * by the service that performs it. Append-only, and never holds a usable signature — the
 * logger truncates those before they reach a row.
 */
@Entity("audit_events")
export class AuditEventEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index("audit_events_ref")
  @Column("text", { nullable: true })
  ref!: string | null;

  @Index("audit_events_action")
  @Column("text")
  action!: string;

  @Column("text")
  outcome!: string;

  /** JSON, stringified by the repository so a hand-edited row cannot break a read. */
  @Column("text", { nullable: true })
  detail!: string | null;

  @Index("audit_events_created_at")
  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;
}
