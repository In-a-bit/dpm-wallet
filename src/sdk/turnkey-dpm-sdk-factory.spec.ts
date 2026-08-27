import { loadConfig, type Config } from "../config";
import { DpmwError } from "../errors";
import { setLogLevel } from "../observability/log";
import { FakeSignerProvider } from "../testing/fake-signer-provider";
import { testEnv } from "../testing/env";
import { BUILDER_API_PRIVATE_KEY_HEADER } from "./builder-key-fetch";
import { TurnkeyDpmSdkFactory } from "./turnkey-dpm-sdk-factory";

const CONTRACT_INFO = {
  collateral: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  ctf: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  ctf_exchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  proxy_factory: "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052",
  relay_hub: "0xD216153c06e857Cd7F72665e0aF1D7d82172f495",
};

/** Captured before any stub replaces it, so `afterEach` restores the genuine implementation. */
const REAL_FETCH = globalThis.fetch;

describe("the shared signing SDK", () => {
  let config: Config;
  let provider: FakeSignerProvider;
  let contractInfoReads: number;
  let contractInfoHeaders: Headers;

  beforeEach(() => {
    config = loadConfig(testEnv({ DATABASE_URL: "postgres://unused" }));
    // Nothing boots the app here, so the level a boot would apply is applied by hand.
    setLogLevel(config.logLevel);
    provider = new FakeSignerProvider();
    provider.adoptCredentials({
      subOrgId: "sub-org-1",
      walletId: "wallet-1",
      apiPublicKey: "02".padEnd(66, "a"),
      apiPrivateKey: "".padEnd(64, "b"),
    });
    contractInfoReads = 0;
    contractInfoHeaders = new Headers();
    globalThis.fetch = async (_input, init) => {
      contractInfoReads += 1;
      contractInfoHeaders = new Headers(init?.headers);
      return Response.json(CONTRACT_INFO);
    };
  });

  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
  });

  it("reads the contract addresses from the relayer", async () => {
    const sdk = await new TurnkeyDpmSdkFactory(provider, config).getSdk();

    expect(sdk.contractInfo).toMatchObject({
      chainId: String(config.chainId),
      relayHub: CONTRACT_INFO.relay_hub,
      collateral: CONTRACT_INFO.collateral,
    });
  });

  // relayer-api gates every route but /healthz, /metrics and /swagger/*, contract-info
  // included, so the read is unauthorized without this — which is exactly the bug this
  // guards against.
  it("authenticates the contract-info read with the builder secret", async () => {
    await new TurnkeyDpmSdkFactory(provider, config).getSdk();

    expect(contractInfoHeaders.get(BUILDER_API_PRIVATE_KEY_HEADER)).toBe(
      config.relayer.builderApiKey,
    );
  });

  // The whole reason the instance is held: a per-request build would open a Turnkey client and
  // re-read the addresses on every signature.
  it("builds once and reuses it", async () => {
    const factory = new TurnkeyDpmSdkFactory(provider, config);

    const [first, second] = await Promise.all([factory.getSdk(), factory.getSdk()]);
    const third = await factory.getSdk();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(contractInfoReads).toBe(1);
  });

  it("gives each address its own port without rebuilding", async () => {
    const sdk = await new TurnkeyDpmSdkFactory(provider, config).getSdk();

    const port = sdk.getWalletPortFor("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(await port.getEoaAddress()).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(contractInfoReads).toBe(1);
  });

  /**
   * The addresses are read from the relayer now, so an outage on the first signing request has
   * to arrive as the relayer failure it is. The SDK bundles its error classes per entry point,
   * so nothing upstream can recognise them by `instanceof`.
   */
  it("reports an unreachable relayer as RELAYER_REQUEST_FAILED", async () => {
    globalThis.fetch = async () => new Response("boom", { status: 503 });

    await expect(new TurnkeyDpmSdkFactory(provider, config).getSdk()).rejects.toMatchObject({
      code: "RELAYER_REQUEST_FAILED",
      status: 502,
    });
  });

  /**
   * Setting up the SDK is more than reading from the relayer, and a relayer that answered is
   * not the one to blame for an answer this install cannot use.
   */
  it("reports a failure that is not the relayer's as INTERNAL_ERROR", async () => {
    globalThis.fetch = async () => Response.json({ ...CONTRACT_INFO, relay_hub: "" });

    await expect(new TurnkeyDpmSdkFactory(provider, config).getSdk()).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("refuses to act for a vault that holds no credentials yet", async () => {
    const factory = new TurnkeyDpmSdkFactory(new FakeSignerProvider(), config);
    await expect(factory.getSdk()).rejects.toThrow();
  });

  // An install initialised after its first request, or one whose first attempt hit a relayer
  // that was briefly down, must be able to succeed later.
  it("does not cache a failed build", async () => {
    globalThis.fetch = async () => new Response("boom", { status: 503 });
    const factory = new TurnkeyDpmSdkFactory(provider, config);
    await expect(factory.getSdk()).rejects.toBeInstanceOf(DpmwError);

    globalThis.fetch = async () => Response.json(CONTRACT_INFO);
    const sdk = await factory.getSdk();

    expect(sdk.contractInfo.relayHub).toBe(CONTRACT_INFO.relay_hub);
  });
});
