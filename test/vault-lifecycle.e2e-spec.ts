import { AuditAction } from "../src/observability/audit-action";
import { startHarness, type Harness } from "../src/testing/harness";

describe("vault init", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("mints a key pair, creates a sub-organisation and adopts its credentials", async () => {
    const response = await harness.post("/v1/vault/init");
    const state = harness.vaultState.load();

    expect(response.status).toBe(200);
    expect(harness.dpmApi.createdCount).toBe(1);
    expect(state?.initialized).toBe(true);
    expect(state?.subOrgId).toBe("fake-sub-org-1");
    expect(state?.subOrgName).toBe("dpm-builder-1-fake-1");
    expect(state?.turnkeyWalletId).toBe("fake-wallet-1");
    expect(response.body.subOrgName).toBe("dpm-builder-1-fake-1");
    expect(harness.provider.adopted?.subOrgId).toBe("fake-sub-org-1");
    expect(harness.provider.adopted?.walletId).toBe("fake-wallet-1");
  });

  // The sub-organisation arrives holding an empty HD wallet, so init derives nothing. Every
  // address is minted later by POST /v1/addresses, starting at index 0.
  it("issues no address", async () => {
    await harness.post("/v1/vault/init");
    const directory = await harness.get("/v1/addresses");

    expect(directory.body.total).toBe(0);
    expect(countRows(harness, "wallets")).toBe(0);
  });

  it("sends only the public key and the wallet name", async () => {
    await harness.post("/v1/vault/init");

    expect(harness.dpmApi.requests).toEqual([
      {
        apiPublicKey: harness.vaultState.load()?.subOrgApiPublicKey,
        walletName: "dpm-wallet",
      },
    ]);
  });

  // The private key is the only secret on the volume, so it is stored encrypted and the
  // plaintext never reaches a column.
  it("stores the private key encrypted and the public key in the clear", async () => {
    await harness.post("/v1/vault/init");
    const state = harness.vaultState.load();

    expect(state?.subOrgApiPublicKey).toBe(harness.provider.adopted?.apiPublicKey);
    expect(state?.subOrgApiPrivateKeyEncrypted).toMatch(/^v1\./);
    expect(state?.subOrgApiPrivateKeyEncrypted).not.toContain(
      harness.provider.adopted?.apiPrivateKey,
    );
  });

  it("writes nothing on a second init", async () => {
    const first = await harness.post("/v1/vault/init");
    const second = await harness.post("/v1/vault/init");

    expect(second.status).toBe(200);
    expect(second.body.subOrgName).toBe(first.body.subOrgName);
    expect(harness.dpmApi.requests).toHaveLength(1);
    expect(countRows(harness, "vault_state")).toBe(1);
    expect(auditActions(harness)).toEqual([AuditAction.VaultInit]);
  });

  it("resumes with the same key pair after dpm-api rejected the first attempt", async () => {
    harness.dpmApi.failWith = new Error("dpm-api is down");
    const failed = await harness.post("/v1/vault/init");
    const reserved = harness.vaultState.load();

    harness.dpmApi.failWith = undefined;
    const retried = await harness.post("/v1/vault/init");

    expect(failed.status).toBe(500);
    expect(reserved?.initialized).toBe(false);
    expect(retried.status).toBe(200);
    // Same key pair, so dpm-api recognises the retry and hands back one sub-organisation
    // rather than stranding the first.
    expect(harness.vaultState.load()?.subOrgApiPublicKey).toBe(reserved?.subOrgApiPublicKey);
    expect(harness.dpmApi.createdCount).toBe(1);
  });
});

/**
 * Vault init writes the state row's one transition and the audit event as a single unit. A
 * partial write is unrecoverable, because that row makes its transition exactly once: the
 * vault would read as initialised with no trail of how it got there, or claim an
 * initialisation the state row never recorded. These tests fail the second write and assert
 * the volume is left resumable — the reserved key pair survives, and nothing says the vault
 * is ready.
 */
describe("vault init atomicity", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("leaves the state row reserved when the audit write fails", async () => {
    failAuditWrites(harness);

    const response = await harness.post("/v1/vault/init");

    expect(response.status).toBe(500);
    expect(harness.vaultState.load()?.initialized).toBe(false);
    expect(harness.vaultState.load()?.subOrgId).toBeNull();
    expect(auditActions(harness)).not.toContain(AuditAction.VaultInit);
  });

  it("initialises cleanly once the obstruction is gone, with no duplicate rows", async () => {
    const restoreAudit = failAuditWrites(harness);
    await harness.post("/v1/vault/init");
    restoreAudit();

    const response = await harness.post("/v1/vault/init");

    expect(response.status).toBe(200);
    expect(countRows(harness, "vault_state")).toBe(1);
    expect(auditActions(harness)).toEqual([AuditAction.VaultInit]);
  });

  it("adopts the sub-organisation the failed attempt already created", async () => {
    const restoreAudit = failAuditWrites(harness);
    await harness.post("/v1/vault/init");
    restoreAudit();

    const response = await harness.post("/v1/vault/init");

    // The first attempt already created the sub-org. Retrying must adopt it rather than ask
    // for a second one and orphan the first.
    expect(response.body.subOrgName).toBe("dpm-builder-1-fake-1");
    expect(harness.dpmApi.createdCount).toBe(1);
  });
});

/** Makes every audit write throw, and returns the undo. */
function failAuditWrites(harness: Harness): () => void {
  const audit = harness.audit;
  const record = audit.record.bind(audit);
  audit.record = () => {
    throw new Error("disk full");
  };
  return () => {
    audit.record = record;
  };
}

function countRows(harness: Harness, table: "vault_state" | "wallets"): number {
  const row = harness.db.$client.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
    total: number;
  };
  return row.total;
}

function auditActions(harness: Harness): string[] {
  const rows = harness.db.$client.prepare("SELECT action FROM audit_events").all() as {
    action: string;
  }[];
  return rows.map((row) => row.action);
}
