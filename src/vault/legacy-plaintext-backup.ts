import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { decryptCredential, type EncryptionKey } from "../crypto/credential-encryption";
import { logInfo, logWarn } from "../observability/log";

const LEGACY_FILE = "api-key-pair.plaintext.json";

/**
 * Earlier builds wrote the generated API key pair, private half included, to this file on the
 * data volume. The encrypted copy in the database is the only one kept now, so a leftover
 * file is removed at boot — but only once the database's copy is proven usable: its public key
 * matches and, decrypted with the current encryption key, its private key equals the file's.
 * A wrong or lost DPM_WALLET_ENCRYPTION_KEY, or a corrupt ciphertext, therefore leaves the
 * file — possibly the only working copy — in place. Nothing here logs key material.
 */
export function removeLegacyPlaintextBackup(
  dataDir: string,
  stored: StoredApiKeyPair | undefined,
  encryptionKey: EncryptionKey,
): void {
  const file = path.join(dataDir, LEGACY_FILE);
  if (!existsSync(file)) return;

  const reason = mismatch(file, stored, encryptionKey);
  if (reason) {
    logWarn("vault.plaintext_backup_kept", { file, reason });
    return;
  }
  try {
    rmSync(file);
  } catch (err) {
    // A read-only mount must not stop the service from booting.
    logWarn("vault.plaintext_backup_remove_failed", {
      file,
      code: (err as { code?: string }).code,
    });
    return;
  }
  logInfo("vault.plaintext_backup_removed", { file });
}

export type StoredApiKeyPair = {
  subOrgApiPublicKey: string;
  subOrgApiPrivateKeyEncrypted: string;
};

/** Why the file cannot be proven redundant, or undefined when the database holds the same pair. */
function mismatch(
  file: string,
  stored: StoredApiKeyPair | undefined,
  encryptionKey: EncryptionKey,
): string | undefined {
  if (!stored) return "the database holds no key pair";
  const parsed = readPair(file);
  if (parsed?.apiPublicKey !== stored.subOrgApiPublicKey) {
    return "its public key does not match the database";
  }
  let decrypted: string;
  try {
    decrypted = decryptCredential(encryptionKey, stored.subOrgApiPrivateKeyEncrypted);
  } catch {
    return "the database copy of the private key cannot be decrypted";
  }
  return sameSecret(decrypted, parsed.apiPrivateKey)
    ? undefined
    : "its private key does not match the database";
}

function sameSecret(left: string, right: string | undefined): boolean {
  if (right === undefined) return false;
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function readPair(file: string): { apiPublicKey?: string; apiPrivateKey?: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null;
    const text = (value: unknown): string | undefined =>
      typeof value === "string" ? value : undefined;
    return { apiPublicKey: text(parsed?.apiPublicKey), apiPrivateKey: text(parsed?.apiPrivateKey) };
  } catch {
    return undefined;
  }
}
