import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { compressP256PublicKey, generateApiKeyPair } from "./api-key-pair.js";

describe("generateApiKeyPair", () => {
  it("produces a 33-byte compressed public key and a 32-byte private scalar", () => {
    const { publicKeyHex, privateKeyHex } = generateApiKeyPair();
    expect(publicKeyHex).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different pair on every call", () => {
    expect(generateApiKeyPair().privateKeyHex).not.toBe(generateApiKeyPair().privateKeyHex);
  });

  /**
   * The compressed form has to round-trip through a real P-256 implementation, because a
   * key Turnkey cannot decompress authenticates nothing and the failure would only surface
   * on the first signature.
   */
  it("produces a public key node can decompress back to the same point", () => {
    const { publicKeyHex } = generateApiKeyPair();
    const uncompressed = crypto.ECDH.convertKey(
      Buffer.from(publicKeyHex, "hex"),
      "prime256v1",
      undefined,
      undefined,
      "uncompressed",
    ) as Buffer;
    expect(compressP256PublicKey(uncompressed)).toBe(publicKeyHex);
  });
});

describe("compressP256PublicKey", () => {
  // The prefix encodes y's parity; getting it backwards yields a valid-looking key for the
  // mirrored point, which authenticates nothing.
  it("uses 02 for an even y and 03 for an odd one", () => {
    const evenY = point(1n, 2n);
    const oddY = point(1n, 3n);
    expect(compressP256PublicKey(evenY).slice(0, 2)).toBe("02");
    expect(compressP256PublicKey(oddY).slice(0, 2)).toBe("03");
  });

  it("carries x through unchanged", () => {
    const x = 0x1122334455667788n;
    expect(compressP256PublicKey(point(x, 2n)).slice(2)).toBe(hex32(x));
  });

  it("rejects anything that is not a 65-byte uncompressed point", () => {
    expect(() => compressP256PublicKey(Buffer.alloc(64, 0))).toThrow(/uncompressed/);
    // Right length, wrong prefix: a compressed point passed in by mistake.
    const wrongPrefix = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 0)]);
    expect(() => compressP256PublicKey(wrongPrefix)).toThrow(/uncompressed/);
  });
});

function point(x: bigint, y: bigint): Buffer {
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(hex32(x), "hex"),
    Buffer.from(hex32(y), "hex"),
  ]);
}

function hex32(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}
