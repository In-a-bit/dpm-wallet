import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { closeDatabase } from "../db/client.js";
import type { Runtime } from "../runtime.js";
import { bootstrap } from "../startup/bootstrap.js";
import { API_KEY_HEADER } from "../http/middleware/api-key.js";
import { IDEMPOTENCY_KEY_HEADER } from "../http/middleware/idempotency.js";
import { FakeDpmApi } from "./fake-dpm-api.js";
import { FakeSignerProvider } from "./fake-signer-provider.js";
import { TEST_API_KEY, testEnv } from "./env.js";

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
  runtime: Runtime;
  provider: FakeSignerProvider;
  dpmApi: FakeDpmApi;
  get: <T = any>(path: string, options?: RequestOptions) => Promise<HttpResult<T>>;
  post: <T = any>(path: string, options?: RequestOptions) => Promise<HttpResult<T>>;
  close: () => Promise<void>;
};

export type HarnessOptions = {
  /** Reuses a stub across reboots, the way a real sub-organisation outlives a container. */
  dpmApi?: FakeDpmApi;
};

/**
 * Boots the real app against an in-memory database and a local signer, listening on an ephemeral
 * port. Going over real HTTP means a test exercises the actual middleware chain, migrations, and
 * repositories rather than a hand-wired subset.
 */
export async function startHarness(
  overrides: Record<string, string> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const { TEST_MNEMONIC: mnemonic, ...env } = overrides;
  const provider = new FakeSignerProvider(mnemonic);
  // The same mnemonic on both fakes, because the master account the sub-organisation call
  // creates has to be one the signer holds — as it is in the real pair.
  const dpmApi = options.dpmApi ?? new FakeDpmApi(mnemonic);
  const runtime = await bootstrap(loadConfig(testEnv(env)), { provider, dpmApi });
  const server = await listen(createApp(runtime));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Captured before any test stubs the global, so stubbing fetch to exercise an upstream failure
  // cannot accidentally intercept the harness's own requests to the app.
  const realFetch = globalThis.fetch;

  const send = async <T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<HttpResult<T>> => {
    const response = await realFetch(`${baseUrl}${path}`, {
      method,
      headers: buildHeaders(options),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: (await parseBody(response)) as T };
  };

  return {
    runtime,
    provider,
    dpmApi,
    get: (path, options) => send("GET", path, options),
    post: (path, options) => send("POST", path, options),
    close: async () => {
      await closeServer(server);
      closeDatabase(runtime.db);
    },
  };
}

function buildHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = options.apiKey === undefined ? TEST_API_KEY : options.apiKey;
  if (apiKey !== null) headers[API_KEY_HEADER] = apiKey;
  if (options.idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
  return headers;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function listen(app: ReturnType<typeof createApp>): Promise<Server> {
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}
