import { DpmwError } from "../errors";
import { DataApiClient } from "./data-api.client";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ROW = {
  user: ADDRESS,
  decimals: 6,
  balanceRaw: "1500000",
  balance: 1.5,
  blockNumber: 42,
  updatedAt: "2026-10-23T00:00:00Z",
};

describe("DataApiClient.batchBalances", () => {
  const realFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(async () => new Response(JSON.stringify([ROW]), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const client = (identity: { builderApiKey: string; lpApiKey?: string }, baseUrl?: string) =>
    new DataApiClient({ baseUrl }, identity);
  const builder = () => client({ builderApiKey: "bld_sk_test" }, "https://data-api.test");

  it("posts {users} to /balances/batch-get and returns the rows", async () => {
    const rows = await builder().batchBalances([ADDRESS]);

    expect(rows).toEqual([ROW]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://data-api.test/balances/batch-get");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ users: [ADDRESS] });
  });

  it("presents the builder secret alone, with no address header", async () => {
    await builder().batchBalances([ADDRESS]);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["X-Builder-Api-Private-Key"]).toBe("bld_sk_test");
    expect(headers["X-Builder-Address"]).toBeUndefined();
    expect(headers["X-LP-Api-Key"]).toBeUndefined();
  });

  it("presents the LP key instead on an LP-owned install", async () => {
    await client(
      { builderApiKey: "bld_sk_test", lpApiKey: "lp_key" },
      "https://data-api.test",
    ).batchBalances([ADDRESS]);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["X-LP-Api-Key"]).toBe("lp_key");
    expect(headers["X-Builder-Api-Private-Key"]).toBeUndefined();
  });

  it("reports an unset DATA_API_URL as BALANCES_UNAVAILABLE", async () => {
    const failure = await client({ builderApiKey: "k" })
      .batchBalances([ADDRESS])
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DpmwError);
    expect((failure as DpmwError).code).toBe("BALANCES_UNAVAILABLE");
    expect((failure as DpmwError).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a refusing data-api as RELAYER_REQUEST_FAILED", async () => {
    fetchMock.mockResolvedValue(new Response("forbidden", { status: 403 }));

    const failure = await builder()
      .batchBalances([ADDRESS])
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DpmwError);
    expect((failure as DpmwError).code).toBe("RELAYER_REQUEST_FAILED");
    expect((failure as DpmwError).message).toContain("data-api");
  });

  it("reports an unreachable data-api as RELAYER_REQUEST_FAILED", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const failure = await builder()
      .batchBalances([ADDRESS])
      .catch((err: unknown) => err);

    expect((failure as DpmwError).code).toBe("RELAYER_REQUEST_FAILED");
  });
});
