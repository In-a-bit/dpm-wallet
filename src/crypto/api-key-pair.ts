import crypto from "node:crypto";

/**
 * A Turnkey API key pair. The public half is registered as this install's root-user
 * credential inside its sub-organisation; the private half authorises every request
 * to Turnkey and is the only secret this container holds.
 *
 * Neither half is a signing key: they authenticate requests. The secp256k1 keys that
 * sign orders and transactions never leave the Turnkey TEE.
 */
export type ApiKeyPair = {
  /** Compressed P-256 point, 33 bytes hex — the form Turnkey expects. */
  publicKeyHex: string;
  /** The P-256 scalar, 32 bytes hex. */
  privateKeyHex: string;
};

/**
 * Generates the key pair this install presents to Turnkey. Called exactly once, on first
 * initialisation, and the result is what makes the install's sub-organisation reachable
 * only by this install.
 */
export function generateApiKeyPair(): ApiKeyPair {
  const keyPair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = keyPair.publicKey.export({ type: "spki", format: "der" });
  // The uncompressed point is the last 65 bytes of the SPKI encoding: 0x04 ‖ x ‖ y.
  const uncompressed = spki.subarray(spki.length - 65);
  const jwk = keyPair.privateKey.export({ format: "jwk" });
  if (!jwk.d) throw new Error("generated P-256 key has no private scalar");
  return {
    publicKeyHex: compressP256PublicKey(uncompressed),
    privateKeyHex: Buffer.from(jwk.d, "base64url").toString("hex"),
  };
}

/**
 * Compresses an uncompressed P-256 point to the `02`/`03` ‖ x form. The prefix encodes
 * y's parity, which is what lets y be recovered from x alone.
 */
export function compressP256PublicKey(uncompressed: Buffer): string {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error("expected a 65-byte uncompressed P-256 point");
  }
  const x = uncompressed.subarray(1, 33);
  const y = uncompressed.subarray(33, 65);
  const yIsEven = y[y.length - 1]! % 2 === 0;
  return (yIsEven ? "02" : "03") + x.toString("hex");
}
