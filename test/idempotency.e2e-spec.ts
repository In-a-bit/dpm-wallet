import { startHarness, type Harness } from "../src/testing/harness";

const CUSTOMER = "customer-12345";

async function pendingRows(harness: Harness): Promise<number> {
  const rows: unknown[] = await harness.db.query(
    `SELECT 1 FROM idempotency_keys WHERE response_json IS NULL`,
  );
  return rows.length;
}

describe("idempotency", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
    await harness.post("/v1/vault/init");
  });

  afterEach(async () => {
    await harness.close();
  });

  it("scopes a key to the route: the same key on another route is a fresh request", async () => {
    const created = await harness.post("/v1/addresses", {
      body: { ref: CUSTOMER },
      idempotencyKey: "shared",
    });
    const registered = await harness.post(`/v1/addresses/${CUSTOMER}/dpm-registered`, {
      body: {},
      idempotencyKey: "shared",
    });

    expect(created.status).toBe(200);
    expect(registered.body).not.toEqual(created.body);
    expect(registered.body.error?.code).not.toBe("IDEMPOTENCY_CONFLICT");
  });

  it("ignores the header on a GET", async () => {
    await harness.get("/v1/addresses", { idempotencyKey: "get-key" });

    const rows: unknown[] = await harness.db.query(`SELECT 1 FROM idempotency_keys`);
    expect(rows).toHaveLength(0);
  });

  it("does not store anything for a route that is not authenticated", async () => {
    await harness.post("/v1/vault/init", { apiKey: null, idempotencyKey: "anon" });

    const rows: unknown[] = await harness.db.query(`SELECT 1 FROM idempotency_keys`);
    expect(rows).toHaveLength(0);
  });

  // Empty-body route: only the URL tells the two requests apart.
  it("does not replay one ref's response to another ref under the same key", async () => {
    await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
    await harness.post("/v1/addresses", { body: { ref: "customer-2" } });

    const first = await harness.post(`/v1/addresses/${CUSTOMER}/dpm-attestation`, {
      idempotencyKey: "same",
    });
    const second = await harness.post("/v1/addresses/customer-2/dpm-attestation", {
      idempotencyKey: "same",
    });
    const replay = await harness.post(`/v1/addresses/${CUSTOMER}/dpm-attestation`, {
      idempotencyKey: "same",
    });

    expect(second.status).toBe(200);
    expect(second.body.address).not.toBe(first.body.address);
    expect(replay.body).toEqual(first.body);
  });

  it("signs once when a duplicate order arrives while the first is in flight", async () => {
    await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
    const order = {
      ref: CUSTOMER,
      maker: "0x1111111111111111111111111111111111111111",
      side: 0,
      tokenId: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
      shares: 100,
      price: 0.4,
      feeRateBps: 200,
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = harness.provider.signRawPayload.bind(harness.provider);
    const signRaw = jest
      .spyOn(harness.provider, "signRawPayload")
      .mockImplementation(async (...args) => {
        await gate;
        return original(...args);
      });

    const first = harness.post("/v1/sign/order", { body: order, idempotencyKey: "k" });
    while (signRaw.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
    const duplicate = await harness.post("/v1/sign/order", { body: order, idempotencyKey: "k" });
    release();
    const settled = await first;
    const replay = await harness.post("/v1/sign/order", { body: order, idempotencyKey: "k" });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(settled.status).toBe(200);
    expect(replay.body).toEqual(settled.body);
    expect(signRaw).toHaveBeenCalledTimes(1);
  });

  it("deletes the pending row when the handler fails, so a retry runs", async () => {
    jest.spyOn(harness.provider, "createAccount").mockRejectedValueOnce(new Error("turnkey down"));

    const failed = await harness.post("/v1/addresses", {
      body: { ref: CUSTOMER },
      idempotencyKey: "retry",
    });
    expect(failed.status).toBe(500);
    expect(await pendingRows(harness)).toBe(0);

    const retried = await harness.post("/v1/addresses", {
      body: { ref: CUSTOMER },
      idempotencyKey: "retry",
    });
    expect(retried.status).toBe(200);
  });

  it("takes over a pending row abandoned by a crashed process", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await harness.db.query(
      `INSERT INTO idempotency_keys (key, request_hash, response_json, created_at) VALUES ($1, $2, NULL, $3)`,
      ["POST /v1/addresses\nstale", "0x", old],
    );

    const response = await harness.post("/v1/addresses", {
      body: { ref: CUSTOMER },
      idempotencyKey: "stale",
    });

    expect(response.status).toBe(200);
  });
});
