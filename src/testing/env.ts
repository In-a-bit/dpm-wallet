export const TEST_API_KEY = "test-api-key";

/**
 * A complete, valid environment for tests. Every required variable is present, so a test that
 * cares about one value overrides just that one and stays readable.
 */
const BASE_ENV: Record<string, string> = {
  // Keeps test output readable; a test that cares about a log line overrides this.
  LOG_LEVEL: "error",
  DATABASE_PATH: ":memory:",
  DPM_WALLET_API_KEY: TEST_API_KEY,
  DPM_WALLET_ENCRYPTION_KEY: "c8d3934504bc5bdff0e4233964d62bb28505ed139fd55f3ef27e9b8ef3efe751",
  DPM_API_BASE_URL: "https://dpm-api.test",
  RELAYER_BASE_URL: "https://relayer.test",
  RELAYER_BUILDER_API_KEY: "bld_sk_test",
  CHAIN_ID: "137",
  CONTRACT_COLLATERAL: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  CONTRACT_CTF: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  CONTRACT_CTF_EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  CONTRACT_PROXY_FACTORY: "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052",
  CONTRACT_PROXY_IMPL: "0xd216153c06E857cd7f72665E0aF1d7D82172F494",
  CONTRACT_RELAY_HUB: "0xD216153c06e857Cd7F72665e0aF1D7d82172f495",
};

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...BASE_ENV, ...overrides };
}
