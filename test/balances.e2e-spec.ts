import { startHarness, type Harness } from "../src/testing/harness";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ROW = { user: ADDRESS, decimals: 6, balanceRaw: "1500000", balance: 1.5 };

describe("POST /v1/balances", () => {
  let harness: Harness;
  const realFetch = globalThis.fetch;
  let dataApi: jest.Mock;

  beforeEach(async () => {
    harness = await startHarness();
    // supertest talks over node:http, so stubbing global fetch only intercepts the app's own
    // outbound call to data-api.
    dataApi = jest.fn(async () => new Response(JSON.stringify([ROW]), { status: 200 }));
    globalThis.fetch = dataApi as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await harness.close();
  });

  it("rejects a missing key", async () => {
    const response = await harness.post("/v1/balances", {
      apiKey: null,
      body: { addresses: [ADDRESS] },
    });
    expect(response.status).toBe(401);
  });

  it("rejects an empty list", async () => {
    const response = await harness.post("/v1/balances", { body: { addresses: [] } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects more than 100 addresses", async () => {
    const response = await harness.post("/v1/balances", {
      body: { addresses: Array.from({ length: 101 }, () => ADDRESS) },
    });
    expect(response.status).toBe(400);
  });

  it("rejects a malformed address", async () => {
    const response = await harness.post("/v1/balances", { body: { addresses: ["0x12"] } });
    expect(response.status).toBe(400);
  });

  it("returns the rows data-api answers with", async () => {
    const response = await harness.post("/v1/balances", { body: { addresses: [ADDRESS] } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual([ROW]);
    const [url, init] = dataApi.mock.calls[0];
    expect(url).toBe("https://data-api.test/balances/batch-get");
    expect(JSON.parse(init.body)).toEqual({ users: [ADDRESS] });
  });
});
