import crypto from "node:crypto";

import { DpmwError } from "../errors";

/**
 * Encrypts the one credential this container stores on its volume: the Turnkey API
 * private key. AES-256-GCM, so a modified ciphertext fails to decrypt rather than
 * yielding plausible garbage.
 *
 * The stored form is `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The version
 * prefix exists so a future scheme can be told apart from this one without guessing.
 */
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** The AES key, parsed from DPM_WALLET_ENCRYPTION_KEY. */
export type EncryptionKey = Buffer & { readonly __encryptionKey: unique symbol };

/**
 * Parses the configured 64-character hex key. A malformed key is a configuration error the
 * operator has to fix, so it surfaces at boot rather than on the first write.
 */
export function parseEncryptionKey(hex: string): EncryptionKey {
  const key = Buffer.from(hex.trim(), "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `DPM_WALLET_ENCRYPTION_KEY must be ${KEY_BYTES} bytes of hex (${KEY_BYTES * 2} characters)`,
    );
  }
  return key as EncryptionKey;
}

export function encryptCredential(key: EncryptionKey, plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, encode(iv), encode(cipher.getAuthTag()), encode(ciphertext)].join(".");
}

/**
 * Reverses encryptCredential. Every failure — wrong key, wrong format, tampered
 * ciphertext — arrives as the same fatal error: there is no fallback that could produce a
 * usable credential, and continuing without one would make every signature fail with a
 * less obvious cause.
 */
export function decryptCredential(key: EncryptionKey, stored: string): string {
  const [iv, tag, ciphertext] = parseEnvelope(stored);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (cause) {
    throw new DpmwError(
      "INTERNAL_ERROR",
      "Stored credential could not be decrypted; DPM_WALLET_ENCRYPTION_KEY does not match the volume",
      { cause },
    );
  }
}

function parseEnvelope(stored: string): [iv: Buffer, tag: Buffer, ciphertext: Buffer] {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new DpmwError("INTERNAL_ERROR", `Stored credential is not a ${VERSION} envelope`);
  }
  const [, iv, tag, ciphertext] = parts as [string, string, string, string];
  return [decode(iv), decode(tag), decode(ciphertext)];
}

function encode(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
