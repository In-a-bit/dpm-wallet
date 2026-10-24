import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { logInfo, logWarn } from "../observability/log";

const LEGACY_FILE = "api-key-pair.plaintext.json";

/**
 * Earlier builds wrote the generated API key pair, private half included, to this file on the
 * data volume. The encrypted copy in the database is the only one kept now, so a leftover
 * file is removed at boot — but only once the database is confirmed to hold the same pair,
 * so a file that is the sole copy of a key the database never recorded is never destroyed.
 * Nothing here logs key material.
 */
export function removeLegacyPlaintextBackup(
  dataDir: string,
  dbApiPublicKey: string | undefined,
): void {
  const file = path.join(dataDir, LEGACY_FILE);
  if (!existsSync(file)) return;

  if (dbApiPublicKey && readPublicKey(file) === dbApiPublicKey) {
    rmSync(file);
    logInfo("vault.plaintext_backup_removed", { file });
    return;
  }
  logWarn("vault.plaintext_backup_kept", {
    file,
    reason: dbApiPublicKey
      ? "its public key does not match the database"
      : "the database holds no key pair",
  });
}

function readPublicKey(file: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const key = (parsed as { apiPublicKey?: unknown } | null)?.apiPublicKey;
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}
