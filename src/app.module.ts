import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";

import { AddressesModule } from "./addresses/addresses.module";
import { AuditModule } from "./audit/audit.module";
import { BalancesModule } from "./balances/balances.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ApiKeyGuard } from "./common/guards/api-key.guard";
import { IdempotencyInterceptor } from "./common/interceptors/idempotency.interceptor";
import type { Config } from "./config";
import { CONFIG } from "./tokens";
import { createValidationPipe } from "./common/validation/validation-pipe";
import { AppConfigModule } from "./config.module";
import { DatabaseModule } from "./database.module";
import { HealthModule } from "./health/health.module";
import { MaintenanceModule } from "./maintenance/maintenance.module";
import { MetaTxModule } from "./meta-tx/meta-tx.module";
import { ObservabilityModule } from "./observability/observability.module";
import { RelayModule } from "./relay/relay.module";
import { RetentionModule } from "./retention/retention.module";
import { SignModule } from "./sign/sign.module";
import { StartupService } from "./startup/startup.service";
import { VaultModule } from "./vault/vault.module";

/**
 * The composition root. The four app-scoped providers below are what the Express middleware
 * chain used to express positionally: everything is authenticated unless it says `@Public()`,
 * every response is idempotency-aware, every body is validated the same way, and every
 * exception becomes one envelope.
 */
@Module({
  imports: [
    AppConfigModule,
    // One shared per-minute budget for the signing routes (`ThrottlerGuard` on their controllers).
    // In memory per process, and keyed by client address: behind the operator gateway that is
    // one bucket, which is the point — a ceiling on what the gateway can have signed.
    ThrottlerModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: Config) => [{ ttl: 60_000, limit: config.signRateLimitPerMin }],
    }),
    DatabaseModule,
    ObservabilityModule,
    VaultModule,
    HealthModule,
    AddressesModule,
    SignModule,
    MetaTxModule,
    AuditModule,
    BalancesModule,
    RelayModule,
    MaintenanceModule,
    RetentionModule,
  ],
  providers: [
    StartupService,
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule {}
