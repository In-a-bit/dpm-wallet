import { deriveProxyAddress } from "./proxy-address";

const FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";
const IMPLEMENTATION = "0xd216153c06E857cd7f72665E0aF1d7D82172F494";
const CONFIG = { proxyFactory: FACTORY, proxyImplementation: IMPLEMENTATION } as const;

describe("deriveProxyAddress", () => {
  // Cross-checked against libs/crypto/proxy_wallet.go in prediction-bundler, which is the
  // implementation relayer-api and the exchange already agree with. A wrong byte anywhere in
  // the clone init code yields a plausible-looking address that nothing ever deploys to, so
  // this vector is the only thing standing between a typo and unreachable customer funds.
  it("matches the canonical Go derivation", () => {
    expect(deriveProxyAddress("0x1111111111111111111111111111111111111111", CONFIG)).toBe(
      "0x35986F3f58a6e7f26A1DFEa4eafB509241Bd2d48",
    );
  });

  it("is insensitive to the casing of the EOA", () => {
    const lower = deriveProxyAddress("0xabcdef0123456789abcdef0123456789abcdef01", CONFIG);
    const upper = deriveProxyAddress("0xABCDEF0123456789ABCDEF0123456789ABCDEF01", CONFIG);
    expect(lower).toBe(upper);
  });

  it("gives every EOA a distinct proxy", () => {
    const first = deriveProxyAddress("0x1111111111111111111111111111111111111111", CONFIG);
    const second = deriveProxyAddress("0x1111111111111111111111111111111111111112", CONFIG);
    expect(first).not.toBe(second);
  });

  it("depends on the factory and the implementation", () => {
    const eoa = "0x1111111111111111111111111111111111111111";
    const otherFactory = deriveProxyAddress(eoa, {
      proxyFactory: "0x0000000000000000000000000000000000000001",
      proxyImplementation: IMPLEMENTATION,
    });
    const otherImplementation = deriveProxyAddress(eoa, {
      proxyFactory: FACTORY,
      proxyImplementation: "0x0000000000000000000000000000000000000002",
    });
    expect(otherFactory).not.toBe(deriveProxyAddress(eoa, CONFIG));
    expect(otherImplementation).not.toBe(deriveProxyAddress(eoa, CONFIG));
  });
});
