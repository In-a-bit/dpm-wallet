import type { ProxyFactoryConfig } from "../crypto/proxy-address";

export const TEST_API_KEY = "test-api-key";

/**
 * The proxy factory the test environment derives against. Exported rather than inlined below
 * so the dpm-api stub can derive the same proxy the app does — a fake that disagreed would
 * fail the mismatch check on every registration and hide the case the check exists for.
 */
export const TEST_CONTRACTS: ProxyFactoryConfig = {
  proxyFactory: "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052",
  proxyImplementation: "0xd216153c06E857cd7f72665E0aF1d7D82172F494",
};

/**
 * A complete, valid environment for tests. Every required variable is present, so a test that
 * cares about one value overrides just that one and stays readable.
 */
const BASE_ENV: Record<string, string> = {
  // Keeps test output readable; a test that cares about a log line overrides this.
  LOG_LEVEL: "error",
  // `DATABASE_URL` is not here: the harness mints a throwaway database per boot.
  // Gitignored, and keeps the plaintext key pair backup out of the repository root.
  DATA_DIR: "./data",
  DPM_WALLET_API_KEY: TEST_API_KEY,
  DPM_WALLET_ENCRYPTION_KEY: "c8d3934504bc5bdff0e4233964d62bb28505ed139fd55f3ef27e9b8ef3efe751",
  DPM_API_BASE_URL: "https://dpm-api.test",
  GAMMA_API_URL: "https://gamma-api.test",
  APP_API_KEY: "app-api-key-test",
  RELAYER_BASE_URL: "https://relayer.test",
  RELAYER_BUILDER_API_KEY: "bld_sk_test",
  CHAIN_ID: "137",
  CONTRACT_CTF_EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  CONTRACT_PROXY_FACTORY: TEST_CONTRACTS.proxyFactory,
  CONTRACT_PROXY_IMPL: TEST_CONTRACTS.proxyImplementation,
};

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...BASE_ENV, ...overrides };
}
