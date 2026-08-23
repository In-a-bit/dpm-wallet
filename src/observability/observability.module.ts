import { Global, Module } from "@nestjs/common";

import { AuditLog } from "./audit";

/**
 * The audit trail is written from every feature, so it is exported globally rather than
 * re-imported by each one.
 */
@Global()
@Module({
  providers: [AuditLog],
  exports: [AuditLog],
})
export class ObservabilityModule {}
