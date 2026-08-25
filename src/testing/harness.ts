import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../app.module";
import { configureApp } from "../app.setup";
import { loadConfig } from "../config";
import { API_KEY_HEADER } from "../common/guards/api-key.guard";
import { IDEMPOTENCY_KEY_HEADER } from "../common/interceptors/idempotency.interceptor";
import type { Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { VaultStateRepository } from "../db/repositories/vault-state.repo";
import { WalletRepository } from "../db/repositories/wallet.repo";
import { AuditLog } from "../observability/audit";
import { CONFIG, DB, DPM_API, SIGNER_PROVIDER } from "../tokens";
import { TurnkeyKeyVault } from "../vault/turnkey-vault";
import { FakeDpmApi } from "./fake-dpm-api";
import { FakeSignerProvider } from "./fake-signer-provider";
import { TEST_API_KEY, testEnv } from "./env";

export type RequestOptions = {
  body?: unknown;
  apiKey?: string | null;
  idempotencyKey?: string;
};

export type HttpResult<T = any> = {
  status: number;
  body: T;
};

export type Harness = {
  /** The Nest container, for a collaborator not surfaced below. */
  app: INestApplication;
  provider: FakeSignerProvider;
  dpmApi: FakeDpmApi;
  /** Resolved out of the container, so a test asserts against the instance the app is using. */
  vaultState: VaultStateRepository;
  wallets: WalletRepository;
  audit: AuditLog;
  vault: TurnkeyKeyVault;
  db: Db;
  get: <T = any>(path: string, options?: RequestOptions) => Promise<HttpResult<T>>;
  post: <T = any>(path: string, options?: RequestOptions) => Promise<HttpResult<T>>;
  close: () => Promise<void>;
};

export type HarnessOptions = {
  /** Reuses a stub across reboots, the way a real sub-organisation outlives a container. */
  dpmApi?: FakeDpmApi;
};

/**
 * Boots the real application against an in-memory database and a local signer. Only the two
 * outbound collaborators are replaced, so a test exercises the actual guards, interceptor,
 * validation pipe, exception filter, migrations and repositories rather than a hand-wired
 * subset.
 *
 * A reboot test that reuses a `databasePath` will find the schema already applied, because
 * migrating is idempotent.
 */
export async function startHarness(
  overrides: Record<string, string> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const { TEST_MNEMONIC: mnemonic, ...env } = overrides;
  const provider = new FakeSignerProvider(mnemonic);
  const dpmApi = options.dpmApi ?? new FakeDpmApi();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONFIG)
    .useValue(loadConfig(testEnv(env)))
    .overrideProvider(SIGNER_PROVIDER)
    .useValue(provider)
    .overrideProvider(DPM_API)
    .useValue(dpmApi)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  // The service no longer migrates itself, so a test applies the schema the way a deploy does:
  // after the volume is open, before anything boots against it.
  runMigrations(app.get<Db>(DB));
  await initOrClose(app);

  const send = async <T>(
    method: "get" | "post",
    path: string,
    requestOptions: RequestOptions = {},
  ): Promise<HttpResult<T>> => {
    const call = request(app.getHttpServer())[method](path);
    for (const [header, value] of Object.entries(buildHeaders(requestOptions))) {
      void call.set(header, value);
    }
    const response = await (requestOptions.body === undefined
      ? call.send()
      : call.send(requestOptions.body as object));
    return { status: response.status, body: response.body as T };
  };

  return {
    app,
    provider,
    dpmApi,
    vaultState: app.get(VaultStateRepository),
    wallets: app.get(WalletRepository),
    audit: app.get(AuditLog),
    vault: app.get(TurnkeyKeyVault),
    db: app.get<Db>(DB),
    get: (path, requestOptions) => send("get", path, requestOptions),
    post: (path, requestOptions) => send("post", path, requestOptions),
    close: () => app.close(),
  };
}

/**
 * A boot that fails during rehydration still holds the volume's write lock, so the container
 * has to be torn down before the failure is re-thrown to the test.
 */
async function initOrClose(app: INestApplication): Promise<void> {
  try {
    await app.init();
  } catch (err) {
    await app.close().catch(() => undefined);
    throw err;
  }
}

function buildHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = options.apiKey === undefined ? TEST_API_KEY : options.apiKey;
  if (apiKey !== null) headers[API_KEY_HEADER] = apiKey;
  if (options.idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
  return headers;
}
