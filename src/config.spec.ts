import { loadConfig } from "./config";
import { testEnv } from "./testing/env";

const withKey = (key: string | undefined) =>
  testEnv({
    DATABASE_URL: "postgres://x/y",
    ...(key === undefined ? {} : { DPM_WALLET_API_KEY: key }),
  });

describe("DPM_WALLET_API_KEY", () => {
  it("accepts a long random key", () => {
    expect(loadConfig(withKey("dpmw_" + "a1b2c3d4e5".repeat(4))).apiKey).toHaveLength(45);
  });

  it("refuses a key shorter than 32 characters", () => {
    expect(() => loadConfig(withKey("a".repeat(31) + "b"))).not.toThrow();
    expect(() => loadConfig(withKey("short-key"))).toThrow(/at least 32/);
  });

  it.each(["change-me", "CHANGEME", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"])(
    "refuses the placeholder %s once padded to length",
    (placeholder) => {
      const key = placeholder.length >= 32 ? placeholder : `${placeholder}-${"1".repeat(32)}`;
      expect(() => loadConfig(withKey(key))).toThrow(/placeholder/);
    },
  );

  it("is still required", () => {
    expect(() => loadConfig(withKey(""))).toThrow(/required/);
  });
});

describe("ENABLE_API_DOCS", () => {
  const docs = (value: string | undefined) =>
    loadConfig({ ...testEnv({ DATABASE_URL: "postgres://x/y" }), ENABLE_API_DOCS: value })
      .enableApiDocs;

  it("is off by default and on only when asked", () => {
    expect(docs(undefined)).toBe(false);
    expect(docs("false")).toBe(false);
    expect(docs("true")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(() => docs("yes")).toThrow(/ENABLE_API_DOCS/);
  });
});
