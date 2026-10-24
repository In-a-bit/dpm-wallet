import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decryptCredential, type EncryptionKey } from "../src/crypto/credential-encryption";
import { testEnv } from "../src/testing/env";
import { FakeDpmApi } from "../src/testing/fake-dpm-api";
import { startHarness, type Harness } from "../src/testing/harness";
import { createTestDatabase, type TestDatabase } from "../src/testing/pg-test-db";

const LEGACY_FILE = "api-key-pair.plaintext.json";
const TEST_KEY = Buffer.from(testEnv().DPM_WALLET_ENCRYPTION_KEY ?? "", "hex") as EncryptionKey;

/**
 * The Turnkey API private key is stored only encrypted in the database. These tests pin that
 * init leaves nothing readable on the volume, and that a file an older build left behind is
 * removed at boot once the database is confirmed to hold the same pair.
 */
describe("plaintext api key pair backup", () => {
  let database: TestDatabase;
  let dataDir: string;
  let harness: Harness | undefined;
  let dpmApi: FakeDpmApi;
  let logged: string[];

  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = mkdtempSync(path.join(tmpdir(), "dpmw-data-"));
    dpmApi = new FakeDpmApi();
    logged = [];
    const capture = (...args: unknown[]): void => {
      logged.push(String(args[0]));
    };
    jest.spyOn(console, "log").mockImplementation(capture);
    jest.spyOn(console, "error").mockImplementation(capture);
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    await database.drop();
    rmSync(dataDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function boot(extra: Record<string, string> = {}): Promise<Harness> {
    return startHarness(
      { DATABASE_URL: database.url, DATA_DIR: dataDir, LOG_LEVEL: "info", ...extra },
      { dpmApi },
    );
  }

  it("writes nothing to the data directory on init", async () => {
    harness = await boot();
    const response = await harness.post("/v1/vault/init");

    expect(response.status).toBe(200);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("removes a leftover backup whose public key matches the database", async () => {
    const first = await boot();
    await first.post("/v1/vault/init");
    const state = await first.vaultState.load();
    const privateKey = first.provider.adopted?.apiPrivateKey ?? "";
    await first.close();
    const file = path.join(dataDir, LEGACY_FILE);
    writeFileSync(
      file,
      JSON.stringify({ apiPublicKey: state?.subOrgApiPublicKey, apiPrivateKey: privateKey }),
    );
    logged = [];

    harness = await boot();

    expect(existsSync(file)).toBe(false);
    const removed = logged.filter((line) => line.includes("vault.plaintext_backup_removed"));
    expect(removed).toHaveLength(1);
    expect(removed[0]).not.toContain(privateKey);
  });

  it("also removes it while init is only reserved, not yet complete", async () => {
    const first = await boot();
    dpmApi.failWith = new Error("dpm-api is down");
    await first.post("/v1/vault/init");
    const state = await first.vaultState.load();
    const privateKey = decryptCredential(TEST_KEY, state?.subOrgApiPrivateKeyEncrypted ?? "");
    await first.close();
    const file = path.join(dataDir, LEGACY_FILE);
    writeFileSync(
      file,
      JSON.stringify({ apiPublicKey: state?.subOrgApiPublicKey, apiPrivateKey: privateKey }),
    );

    harness = await boot();

    expect(existsSync(file)).toBe(false);
  });

  // The file may be the only working copy when the encryption key is wrong or lost.
  it("keeps the file when the database copy cannot be decrypted", async () => {
    const first = await boot();
    dpmApi.failWith = new Error("dpm-api is down");
    await first.post("/v1/vault/init");
    const state = await first.vaultState.load();
    const privateKey = decryptCredential(TEST_KEY, state?.subOrgApiPrivateKeyEncrypted ?? "");
    await first.close();
    const file = path.join(dataDir, LEGACY_FILE);
    const content = JSON.stringify({
      apiPublicKey: state?.subOrgApiPublicKey,
      apiPrivateKey: privateKey,
    });
    writeFileSync(file, content);
    logged = [];

    harness = await boot({ DPM_WALLET_ENCRYPTION_KEY: "11".repeat(32) });

    expect(readFileSync(file, "utf8")).toBe(content);
    const warned = logged.filter((line) => line.includes("vault.plaintext_backup_kept"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("cannot be decrypted");
    expect(logged.join("\n")).not.toContain(privateKey);
  });

  it("keeps the file when only the private key differs", async () => {
    const first = await boot();
    dpmApi.failWith = new Error("dpm-api is down");
    await first.post("/v1/vault/init");
    const state = await first.vaultState.load();
    await first.close();
    const file = path.join(dataDir, LEGACY_FILE);
    writeFileSync(
      file,
      JSON.stringify({ apiPublicKey: state?.subOrgApiPublicKey, apiPrivateKey: "ab".repeat(32) }),
    );

    harness = await boot();

    expect(existsSync(file)).toBe(true);
  });

  it("still boots when the file cannot be removed", async () => {
    const first = await boot();
    dpmApi.failWith = new Error("dpm-api is down");
    await first.post("/v1/vault/init");
    const state = await first.vaultState.load();
    const privateKey = decryptCredential(TEST_KEY, state?.subOrgApiPrivateKeyEncrypted ?? "");
    await first.close();
    const file = path.join(dataDir, LEGACY_FILE);
    writeFileSync(
      file,
      JSON.stringify({ apiPublicKey: state?.subOrgApiPublicKey, apiPrivateKey: privateKey }),
    );
    chmodSync(dataDir, 0o500);
    logged = [];

    try {
      harness = await boot();
    } finally {
      chmodSync(dataDir, 0o700);
    }

    expect(existsSync(file)).toBe(true);
    expect(logged.some((line) => line.includes("vault.plaintext_backup_remove_failed"))).toBe(true);
  });

  it("keeps a backup whose public key differs and warns", async () => {
    const first = await boot();
    await first.post("/v1/vault/init");
    await first.close();
    const file = path.join(dataDir, LEGACY_FILE);
    const content = JSON.stringify({
      apiPublicKey: "02" + "cd".repeat(32),
      apiPrivateKey: "ef".repeat(32),
    });
    writeFileSync(file, content);
    logged = [];

    harness = await boot();

    expect(readFileSync(file, "utf8")).toBe(content);
    const warned = logged.filter((line) => line.includes("vault.plaintext_backup_kept"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"level":"warn"');
    expect(warned[0]).not.toContain("cd".repeat(32));
    expect(logged.join("\n")).not.toContain("ef".repeat(32));
  });

  it("keeps a backup when the database holds no key pair and warns", async () => {
    const file = path.join(dataDir, LEGACY_FILE);
    const content = JSON.stringify({
      apiPublicKey: "02" + "cd".repeat(32),
      apiPrivateKey: "ef".repeat(32),
    });
    writeFileSync(file, content);

    harness = await boot();

    expect(readFileSync(file, "utf8")).toBe(content);
    expect(logged.filter((line) => line.includes("vault.plaintext_backup_kept"))).toHaveLength(1);
  });

  it("does nothing when there is no backup file", async () => {
    harness = await boot();

    expect(logged.some((line) => line.includes("plaintext_backup"))).toBe(false);
  });
});
