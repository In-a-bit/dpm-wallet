import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeDpmApi } from "../testing/fake-dpm-api.js";
import { startHarness, type Harness } from "../testing/harness.js";

const CUSTOMER = "customer-12345";

/** A second BIP-39 test vector, standing in for a different Turnkey organisation. */
const OTHER_ORGANIZATION_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

/**
 * These tests need a file-backed database: an in-memory one dies with the process, and the whole
 * point is that a restart rebuilds its state from the volume.
 */
describe("cold-start recovery", () => {
  let volume: string;
  let databasePath: string;
  let harness: Harness | undefined;
  // One stub across every boot in a test, the way a sub-organisation outlives a container.
  let dpmApi: FakeDpmApi;

  beforeEach(() => {
    volume = mkdtempSync(join(tmpdir(), "dpm-wallet-"));
    databasePath = join(volume, "dpm-wallet.sqlite");
    dpmApi = new FakeDpmApi();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    rmSync(volume, { recursive: true, force: true });
  });

  async function boot(overrides: Record<string, string> = {}): Promise<Harness> {
    return startHarness({ DATABASE_PATH: databasePath, ...overrides }, { dpmApi });
  }

  it("restores the vault and directory from the volume", async () => {
    const first = await boot();
    await first.post("/v1/vault/init");
    const created = await first.post("/v1/addresses", { body: { ref: CUSTOMER } });
    const master = await first.get("/v1/vault/status");
    await first.close();

    harness = await boot();
    const restored = await harness.get(`/v1/addresses/${CUSTOMER}`);
    const restoredMaster = await harness.get("/v1/vault/status");

    expect(restored.body).toEqual(created.body);
    expect(restoredMaster.body.initialized).toBe(true);
    expect(restoredMaster.body.master.address).toBe(master.body.master.address);
  });

  // The container holds no credential from its environment, so a restart that failed to
  // recover the key pair from the volume could reach Turnkey at all.
  it("re-adopts the sub-organisation credentials from the volume", async () => {
    const first = await boot();
    await first.post("/v1/vault/init");
    const provisioned = first.runtime.vaultState.load();
    await first.close();

    harness = await boot();

    expect(harness.provider.adopted).toEqual({
      subOrgId: provisioned?.subOrgId,
      walletId: provisioned?.turnkeyWalletId,
      apiPublicKey: provisioned?.subOrgApiPublicKey,
      apiPrivateKey: first.provider.adopted?.apiPrivateKey,
    });
  });

  // A crash between minting the key pair and using it leaves a reserved row.
  // Resuming with that pair is what lets dpm-api recognise the retry; a fresh pair would be
  // refused as a second sub-organisation and the install could never initialise.
  it("resumes a reserved key pair after a restart", async () => {
    const first = await boot();
    first.dpmApi.failWith = new Error("dpm-api is down");
    await first.post("/v1/vault/init");
    const reserved = first.runtime.vaultState.load();
    await first.close();

    dpmApi.failWith = undefined;
    harness = await boot();
    const initialized = await harness.post("/v1/vault/init");

    expect(reserved?.initialized).toBe(false);
    expect(initialized.status).toBe(200);
    expect(harness.provider.adopted?.apiPublicKey).toBe(reserved?.subOrgApiPublicKey);
    expect(dpmApi.createdCount).toBe(1);
  });

  // The next index is read from MAX(derivation_index), never from memory, so a restart cannot
  // reissue an index and hand two customers the same address.
  it("continues allocating indices after a restart", async () => {
    const first = await boot();
    await first.post("/v1/vault/init");
    await first.post("/v1/addresses", { body: { ref: "customer-1" } });
    await first.post("/v1/addresses", { body: { ref: "customer-2" } });
    await first.close();

    harness = await boot();
    const third = await harness.post("/v1/addresses", { body: { ref: "customer-3" } });
    expect(third.body.index).toBe(3);
  });

  it("replays an idempotent response across a restart", async () => {
    const first = await boot();
    await first.post("/v1/vault/init");
    const created = await first.post("/v1/addresses", {
      body: { ref: CUSTOMER },
      idempotencyKey: "key-1",
    });
    await first.close();

    harness = await boot();
    const replay = await harness.post("/v1/addresses", {
      body: { ref: CUSTOMER },
      idempotencyKey: "key-1",
    });
    expect(replay.body).toEqual(created.body);
  });

  it("keeps the audit trail continuous", async () => {
    const first = await boot();
    await first.post("/v1/vault/init");
    await first.post("/v1/addresses", { body: { ref: CUSTOMER } });
    await first.close();

    harness = await boot();
    const audit = await harness.get(`/v1/audit?ref=${CUSTOMER}`);
    expect(audit.body.events.map((event: { action: string }) => event.action)).toContain(
      "address.create",
    );
  });

  // Continuing here would silently mint a second, unrelated address tree for refs that already
  // have addresses, so the boot has to fail instead.
  it("refuses to boot when the custody organisation lost a directory address", async () => {
    const first = await boot();
    await first.post("/v1/vault/init");
    await first.post("/v1/addresses", { body: { ref: CUSTOMER } });
    await first.close();

    // A different mnemonic stands in for a database restored against the wrong Turnkey org: the
    // directory's addresses simply are not there.
    await expect(boot({ TEST_MNEMONIC: OTHER_ORGANIZATION_MNEMONIC })).rejects.toThrow(
      /VAULT_DB_MISMATCH/,
    );
  });

  // The mirror case is tolerated, not fatal. A crash between deriving an account and inserting
  // its row leaves exactly this residue, and failing the boot on it would let one badly-timed
  // crash brick the service for good.
  it("boots when the custody organisation holds an address the directory does not", async () => {
    const first = await boot();
    await first.post("/v1/vault/init");
    await first.close();

    // The shared fake provider keeps its accounts keyed by mnemonic, so deriving one here is
    // indistinguishable from a create that died before its row was written.
    const orphaning = await boot();
    await orphaning.runtime.vault.createAccount(9, "orphan");
    await orphaning.close();

    harness = await boot();
    expect((await harness.get("/v1/vault/status")).body.initialized).toBe(true);
  });
});
