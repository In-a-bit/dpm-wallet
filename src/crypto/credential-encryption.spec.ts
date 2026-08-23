import { decryptCredential, encryptCredential, parseEncryptionKey } from "./credential-encryption";

const KEY_HEX = "c8d3934504bc5bdff0e4233964d62bb28505ed139fd55f3ef27e9b8ef3efe751";
const OTHER_KEY_HEX = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const API_PRIVATE_KEY = "2f6a1c8b4d9e30574af2b16c8d0e35719c4a8b2f6d1e903745cab8f26d1e4073";

describe("parseEncryptionKey", () => {
  it("accepts 64 hex characters, with surrounding whitespace", () => {
    expect(parseEncryptionKey(` ${KEY_HEX}\n`)).toHaveLength(32);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => parseEncryptionKey("abcd")).toThrow(/32 bytes of hex/);
  });
});

describe("credential encryption", () => {
  const key = parseEncryptionKey(KEY_HEX);

  it("round-trips a credential", () => {
    expect(decryptCredential(key, encryptCredential(key, API_PRIVATE_KEY))).toBe(API_PRIVATE_KEY);
  });

  it("never stores the plaintext", () => {
    expect(encryptCredential(key, API_PRIVATE_KEY)).not.toContain(API_PRIVATE_KEY);
  });

  it("writes a versioned four-part envelope", () => {
    const parts = encryptCredential(key, API_PRIVATE_KEY).split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
  });

  // A fresh IV per call is what keeps two encryptions of the same credential from being
  // recognisable as equal on disk.
  it("produces a different ciphertext each time", () => {
    expect(encryptCredential(key, API_PRIVATE_KEY)).not.toBe(
      encryptCredential(key, API_PRIVATE_KEY),
    );
  });

  it("fails closed when the auth tag is tampered with", () => {
    const tampered = replacePart(encryptCredential(key, API_PRIVATE_KEY), 2);
    expect(() => decryptCredential(key, tampered)).toThrow(/could not be decrypted/);
  });

  it("fails closed when the ciphertext is tampered with", () => {
    const tampered = replacePart(encryptCredential(key, API_PRIVATE_KEY), 3);
    expect(() => decryptCredential(key, tampered)).toThrow(/could not be decrypted/);
  });

  it("fails closed under a different key", () => {
    const stored = encryptCredential(key, API_PRIVATE_KEY);
    expect(() => decryptCredential(parseEncryptionKey(OTHER_KEY_HEX), stored)).toThrow(
      /does not match the volume/,
    );
  });

  it("rejects an envelope that is not a v1 envelope", () => {
    expect(() => decryptCredential(key, "not-an-envelope")).toThrow(/not a v1 envelope/);
    expect(() => decryptCredential(key, "v2.a.b.c")).toThrow(/not a v1 envelope/);
  });
});

/** Flips the first character of one dot-separated part, leaving the envelope well-formed. */
function replacePart(stored: string, index: number): string {
  const parts = stored.split(".");
  const part = parts[index]!;
  parts[index] = (part[0] === "A" ? "B" : "A") + part.slice(1);
  return parts.join(".");
}
