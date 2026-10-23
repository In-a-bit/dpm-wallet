import { startHarness, type Harness } from "../src/testing/harness";

const REF = "customer-1";
const ACCEPTED = { transactionID: "tx-1", transactionHash: "0xhash", state: "STATE_NEW" };

describe("/v1/relay", () => {
  let harness: Harness;
  const realFetch = globalThis.fetch;
  let upstream: jest.Mock;
  let from: string;
  let request: Record<string, unknown>;

  beforeEach(async () => {
    harness = await startHarness();
    // supertest talks over node:http, so stubbing global fetch only intercepts the relayer call.
    upstream = jest.fn(async () => new Response(JSON.stringify(ACCEPTED), { status: 200 }));
    globalThis.fetch = upstream as typeof fetch;
    await harness.post("/v1/vault/init");
    const created = await harness.post("/v1/addresses", { body: { ref: REF } });
    from = created.body.address;
    request = {
      from,
      to: "0x0000000000000000000000000000000000000001",
      data: "0xabcd",
      nonce: "7",
      signature: "0x" + "11".repeat(65),
      signatureParams: { gasPrice: "0", relayHub: "0x0000000000000000000000000000000000000002" },
      type: "PROXY",
      metadata: "redeem",
    };
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await harness.close();
  });

  it("rejects a missing key", async () => {
    const response = await harness.post("/v1/relay", { apiKey: null, body: request });
    expect(response.status).toBe(401);
  });

  it("rejects a malformed from", async () => {
    const response = await harness.post("/v1/relay", { body: { ...request, from: "0x12" } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("relays the request verbatim and returns the relayer's body", async () => {
    const response = await harness.post("/v1/relay", { body: request });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(ACCEPTED);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://relayer.test/submit");
    expect(JSON.parse(init.body)).toEqual(request);
    expect(init.headers["X-Builder-Address"]).toBe(from);
  });

  it("matches the held address regardless of case", async () => {
    const response = await harness.post("/v1/relay", {
      body: { ...request, from: from.toLowerCase() },
    });
    expect(response.status).toBe(201);
  });

  it("refuses an address this install does not hold, without calling the relayer", async () => {
    const response = await harness.post("/v1/relay", {
      body: { ...request, from: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ADDRESS_NOT_FOUND");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("submits to the relayer once and replays the response for a repeated Idempotency-Key", async () => {
    const first = await harness.post("/v1/relay", { body: request, idempotencyKey: "k1:relay" });
    const second = await harness.post("/v1/relay", { body: request, idempotencyKey: "k1:relay" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("answers IDEMPOTENCY_CONFLICT when the key is reused with a different body", async () => {
    await harness.post("/v1/relay", { body: request, idempotencyKey: "k1:relay" });
    const other = await harness.post("/v1/relay", {
      body: { ...request, nonce: "8" },
      idempotencyKey: "k1:relay",
    });

    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("reports a transaction's state", async () => {
    upstream.mockResolvedValue(
      new Response(JSON.stringify([{ transactionID: "tx-1", state: "STATE_CONFIRMED" }]), {
        status: 200,
      }),
    );

    const response = await harness.get(`/v1/relay/tx-1?from=${from}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ transactionID: "tx-1", state: "STATE_CONFIRMED" });
    expect(upstream.mock.calls[0][0]).toBe("https://relayer.test/transaction?id=tx-1");
  });

  it("refuses a status lookup for an address this install does not hold", async () => {
    const response = await harness.get(
      "/v1/relay/tx-1?from=0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ADDRESS_NOT_FOUND");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 404 RELAY_TRANSACTION_NOT_FOUND for an unknown id", async () => {
    upstream.mockResolvedValue(new Response("[]", { status: 200 }));

    const response = await harness.get(`/v1/relay/nope?from=${from}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("RELAY_TRANSACTION_NOT_FOUND");
  });
});
