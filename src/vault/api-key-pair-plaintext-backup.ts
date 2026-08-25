import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Config } from "../config";
import type { ApiKeyPair } from "../crypto/api-key-pair";

/**
 * A plaintext copy of the generated API key pair, written to the volume next to the
 * database. `reserveApiKeyPair` writes it only once the encrypted copy is confirmed to be
 * the one the database now holds, so this file never records a pair the insert failed to
 * persist or a concurrent init's pair beat to it.
 */
function backupPath(config: Config): string {
  return path.join(path.dirname(config.databasePath), "api-key-pair.plaintext.json");
}

export function writeApiKeyPairBackup(config: Config, pair: ApiKeyPair): void {
  const filePath = backupPath(config);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify({ apiPublicKey: pair.publicKeyHex, apiPrivateKey: pair.privateKeyHex }, null, 2),
    { mode: 0o600 },
  );
}
