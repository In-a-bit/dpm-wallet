import { Column, Entity, PrimaryColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/**
 * Replay protection for POST endpoints. Survives restart, so a client retrying across a
 * container restart gets the original response instead of a second signature.
 */
@Entity("idempotency_keys")
export class IdempotencyKeyEntity {
  @PrimaryColumn("text")
  key!: string;

  @Column("text", { name: "request_hash" })
  requestHash!: string;

  /** NULL while the request that reserved the key is still running. */
  @Column("text", { name: "response_json", nullable: true })
  responseJson!: string | null;

  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;
}
