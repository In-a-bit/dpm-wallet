import { getAddress, isAddress, type Address } from "viem";

/**
 * Phase 1 ships Turnkey only. The union is written out so widening it later (a mnemonic
 * vault, per §13 of the spec) is a one-line change that the config parser picks up.
 */
export const VAULT_MODES = ["turnkey"] as const;
export type VaultMode = (typeof VAULT_MODES)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The addresses this service needs without asking anyone. Everything else a signed
 * transaction refers to — the collateral token, the CTF, the RelayHub — is read from the
 * relayer's `GET /contract-info` by the SDK, so it is not configured twice.
 *
 * These three cannot be: `proxyFactory` and `proxyImplementation` derive a proxy address
 * locally, which `POST /v1/addresses` answers with before any proxy is deployed, and
 * `ctfExchange` is the EIP-712 `verifyingContract` an order is signed against.
 */
export type ContractAddresses = {
  ctfExchange: Address;
  proxyFactory: Address;
  proxyImplementation: Address;
};

export type Config = {
  port: number;
  logLevel: LogLevel;
  /** libpq connection string for the Postgres database holding every table. */
  databaseUrl: string;
  /**
   * The mounted directory. Nothing is written here; boot only looks for a legacy plaintext API
   * key pair backup left by an older build, to delete it.
   */
  dataDir: string;
  vaultMode: VaultMode;
  /** Inbound X-API-Key expected from the operator gateway. */
  apiKey: string;
  /**
   * AES key for the one secret kept on the volume, the Turnkey API private key. Losing it
   * loses access to the sub-organisation, so it belongs in the operator's secret store
   * alongside the volume itself.
   */
  encryptionKey: string;
  turnkey: {
    apiBaseUrl: string;
    /**
     * The name the HD wallet inside this install's sub-organisation is created under. Sent
     * to dpm-api on first init and nothing more: the wallet is addressed by id afterwards.
     */
    walletName: string;
  };
  dpmApi: {
    baseUrl: string;
    /** Identifies a builder-owned install; the same secret the relayer calls use. */
    builderApiKey: string;
    /** Set instead on a liquidity-provider install, which has no builder secret. */
    lpApiKey: string | undefined;
  };
  /**
   * gamma-api, which is a different service from dpm-api above and reached on its own port.
   * Custody onboarding lives here. The builder secret gets through both of its gates: the global
   * one (which also takes the app key) and the custody group's.
   */
  gammaApi: {
    baseUrl: string;
    /**
     * The platform-wide X-API-Key. Only needed against a gamma-api whose global gate predates
     * accepting the builder secret; sent when set, and nothing requires it any more.
     */
    appApiKey: string | undefined;
    /** Sent as X-Builder-Api-Private-Key; identifies which builder owns the address. */
    builderApiKey: string;
  };
  /** data-api, where balances are indexed. Unset leaves `POST /v1/balances` answering 503. */
  dataApi: {
    baseUrl: string | undefined;
  };
  relayer: {
    baseUrl: string;
    /** Sent as X-Builder-Api-Private-Key; never the app-level X-API-Key. */
    builderApiKey: string;
  };
  chainId: number;
  contracts: ContractAddresses;
  /** Requests per minute allowed across `/v1/sign/*` and `/v1/meta-tx/*` together. */
  signRateLimitPerMin: number;
  /** Optional limits on where, and how much, `meta-tx/withdraw` may send. Off unless set. */
  withdraw: {
    /** Lower-cased recipients a withdrawal (or a redeem with a recipient) may pay. Empty = any. */
    recipientAllowlist: ReadonlySet<string>;
    /** Rolling 24h ceiling on the sum of built withdrawals, as a decimal string. */
    maxDailyDecimal: string | undefined;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parsePort(env.PORT),
    logLevel: parseEnum("LOG_LEVEL", env.LOG_LEVEL, LOG_LEVELS, "info"),
    databaseUrl: required("DATABASE_URL", env.DATABASE_URL),
    dataDir: optional(env.DATA_DIR) ?? "/data",
    vaultMode: parseEnum(
      "DPM_WALLET_VAULT_MODE",
      env.DPM_WALLET_VAULT_MODE,
      VAULT_MODES,
      "turnkey",
    ),
    apiKey: required("DPM_WALLET_API_KEY", env.DPM_WALLET_API_KEY),
    encryptionKey: required("DPM_WALLET_ENCRYPTION_KEY", env.DPM_WALLET_ENCRYPTION_KEY),
    turnkey: {
      apiBaseUrl: trimSlash(optional(env.TURNKEY_API_URL) ?? "https://api.turnkey.com"),
      walletName: optional(env.TURNKEY_WALLET_NAME) ?? "dpm-wallet",
    },
    dpmApi: {
      baseUrl: trimSlash(required("DPM_API_BASE_URL", env.DPM_API_BASE_URL)),
      builderApiKey: required("RELAYER_BUILDER_API_KEY", env.RELAYER_BUILDER_API_KEY),
      lpApiKey: optional(env.DPM_LP_API_KEY),
    },
    gammaApi: {
      baseUrl: trimSlash(required("GAMMA_API_URL", env.GAMMA_API_URL)),
      appApiKey: optional(env.APP_API_KEY),
      builderApiKey: required("RELAYER_BUILDER_API_KEY", env.RELAYER_BUILDER_API_KEY),
    },
    dataApi: {
      baseUrl: optional(optional(env.DATA_API_URL)?.replace(/\/$/, "")),
    },
    relayer: {
      baseUrl: trimSlash(required("RELAYER_BASE_URL", env.RELAYER_BASE_URL)),
      builderApiKey: required("RELAYER_BUILDER_API_KEY", env.RELAYER_BUILDER_API_KEY),
    },
    chainId: parseChainId(env.CHAIN_ID),
    contracts: parseContracts(env),
    signRateLimitPerMin: parsePositiveInt(
      "SIGN_RATE_LIMIT_PER_MIN",
      env.SIGN_RATE_LIMIT_PER_MIN,
      600,
    ),
    withdraw: {
      recipientAllowlist: parseAddressList(
        "WITHDRAW_RECIPIENT_ALLOWLIST",
        env.WITHDRAW_RECIPIENT_ALLOWLIST,
      ),
      maxDailyDecimal: parseDecimal("WITHDRAW_MAX_DAILY_DECIMAL", env.WITHDRAW_MAX_DAILY_DECIMAL),
    },
  };
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(optional(raw) ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseAddressList(name: string, raw: string | undefined): ReadonlySet<string> {
  const entries = (optional(raw) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return new Set(entries.map((entry) => parseAddress(name, entry).toLowerCase()));
}

function parseDecimal(name: string, raw: string | undefined): string | undefined {
  const value = optional(raw);
  if (value === undefined) return undefined;
  if (!/^\d+(\.\d{1,18})?$/.test(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive decimal amount`);
  }
  return value;
}

function parseContracts(env: NodeJS.ProcessEnv): ContractAddresses {
  return {
    ctfExchange: requiredAddress("CONTRACT_CTF_EXCHANGE", env.CONTRACT_CTF_EXCHANGE),
    proxyFactory: requiredAddress("CONTRACT_PROXY_FACTORY", env.CONTRACT_PROXY_FACTORY),
    proxyImplementation: requiredAddress("CONTRACT_PROXY_IMPL", env.CONTRACT_PROXY_IMPL),
  };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function required(name: string, value: string | undefined): string {
  const trimmed = optional(value);
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function parsePort(raw: string | undefined): number {
  const port = Number(optional(raw) ?? "8090");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseChainId(raw: string | undefined): number {
  const chainId = Number(optional(raw) ?? "137");
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("CHAIN_ID must be a positive integer");
  }
  return chainId;
}

function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = optional(raw);
  if (!value) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseAddress(name: string, raw: string): Address {
  if (!isAddress(raw, { strict: false })) {
    throw new Error(`${name} must be a 20-byte hex address`);
  }
  return getAddress(raw);
}

function requiredAddress(name: string, raw: string | undefined): Address {
  return parseAddress(name, required(name, raw));
}
