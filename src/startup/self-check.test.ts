import { EXCHANGE_DOMAIN_NAME } from "@inabit-com/dpm-sdk/server";
import { describe, expect, it } from "vitest";

import { assertExchangeDomain, fixtureDigest } from "./self-check.js";

describe("assertExchangeDomain", () => {
  it("passes against the SDK's domain name", () => {
    expect(() => assertExchangeDomain()).not.toThrow();
  });

  it("is pinned to the DPM exchange, not the Polymarket one it was forked from", () => {
    expect(EXCHANGE_DOMAIN_NAME).toBe("DPM CTF Exchange");
  });

  // This is the whole point of the pin: an order signed under the old Polymarket domain name
  // is a valid signature over the wrong digest, so the exchange rejects it with no indication
  // of why. Boot is the only place that failure is cheap to notice.
  it("produces a different digest for every domain name", () => {
    expect(fixtureDigest("DPM CTF Exchange")).not.toBe(fixtureDigest("Polymarket CTF Exchange"));
  });
});
