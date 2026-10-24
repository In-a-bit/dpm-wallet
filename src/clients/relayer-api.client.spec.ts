import { DpmwError } from "../errors";
import { RelayerApiClient } from "./relayer-api.client";

const FROM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const REQUEST = {
  from: FROM,
  to: "0x0000000000000000000000000000000000000001",
  data: "0xabcd",
  nonce: "7",
  signature: "0x" + "11".repeat(65),
  signatureParams: { gasPrice: "0", relayHub: "0x0000000000000000000000000000000000000002" },
  type: "PROXY" as const,
};
const ACCEPTED = { transactionID: "tx-1", transactionHash: "0xhash", state: "STATE_NEW" };

describe("RelayerApiClient", () => {
  const realFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(async () => new Response(JSON.stringify(ACCEPTED), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const client = (
    identity: { builderApiKey: string; lpApiKey?: string } = { builderApiKey: "bld_sk_test" },
  ) => new RelayerApiClient({ baseUrl: "https://relayer.test" }, identity);

  describe("submit", () => {
    it("posts the request verbatim, acting as its signer, and returns the body unchanged", async () => {
      const result = await client().submit(REQUEST);

      expect(result).toEqual(ACCEPTED);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://relayer.test/submit");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual(REQUEST);
      expect(init.headers["X-Builder-Api-Private-Key"]).toBe("bld_sk_test");
      expect(init.headers["X-Builder-Address"]).toBe(FROM);
    });

    it("presents the LP key and address on an LP install", async () => {
      await client({ builderApiKey: "bld_sk_test", lpApiKey: "lp_key" }).submit(REQUEST);

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers["X-LP-Api-Key"]).toBe("lp_key");
      expect(headers["X-LP-Address"]).toBe(FROM);
      expect(headers["X-Builder-Api-Private-Key"]).toBeUndefined();
    });

    it("reports a relayer that refuses the submission (4xx) as RELAY_REJECTED", async () => {
      fetchMock.mockResolvedValue(new Response("bad nonce", { status: 400 }));

      const failure = await client()
        .submit(REQUEST)
        .catch((err: unknown) => err);

      expect((failure as DpmwError).code).toBe("RELAY_REJECTED");
      expect((failure as DpmwError).status).toBe(422);
      expect((failure as DpmwError).message).not.toContain("bad nonce");
      expect((failure as DpmwError).internal).toContain("bad nonce");
    });

    it("truncates the relayer's refusal message", async () => {
      fetchMock.mockResolvedValue(new Response("x".repeat(500), { status: 422 }));

      const failure = (await client()
        .submit(REQUEST)
        .catch((err: unknown) => err)) as DpmwError;

      expect(failure.code).toBe("RELAY_REJECTED");
      expect(failure.message).not.toContain("xx");
      expect(failure.internal).toContain("x".repeat(200));
      expect(failure.internal).not.toContain("x".repeat(201));
    });

    it("reports a failing relayer (5xx) as RELAYER_REQUEST_FAILED", async () => {
      fetchMock.mockResolvedValue(new Response("boom", { status: 503 }));

      const failure = await client()
        .submit(REQUEST)
        .catch((err: unknown) => err);

      expect((failure as DpmwError).code).toBe("RELAYER_REQUEST_FAILED");
      expect((failure as DpmwError).status).toBe(502);
    });

    it("reports an unreachable relayer as RELAYER_REQUEST_FAILED", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      const failure = await client()
        .submit(REQUEST)
        .catch((err: unknown) => err);

      expect((failure as DpmwError).code).toBe("RELAYER_REQUEST_FAILED");
    });
  });

  describe("transaction", () => {
    it("queries by id as the signer and returns the first element", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify([{ transactionID: "tx-1", state: "STATE_CONFIRMED" }]), {
          status: 200,
        }),
      );

      const result = await client().transaction("tx 1", FROM);

      expect(result).toEqual({ transactionID: "tx-1", state: "STATE_CONFIRMED" });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://relayer.test/transaction?id=tx%201");
      expect(init.method).toBe("GET");
      expect(init.headers["X-Builder-Api-Private-Key"]).toBe("bld_sk_test");
      expect(init.headers["X-Builder-Address"]).toBe(FROM);
    });

    it("reports an empty array as RELAY_TRANSACTION_NOT_FOUND", async () => {
      fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));

      const failure = await client()
        .transaction("tx-1", FROM)
        .catch((err: unknown) => err);

      expect((failure as DpmwError).code).toBe("RELAY_TRANSACTION_NOT_FOUND");
      expect((failure as DpmwError).status).toBe(404);
    });

    it("reports a relayer 404 as RELAY_TRANSACTION_NOT_FOUND", async () => {
      fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));

      const failure = await client()
        .transaction("tx-1", FROM)
        .catch((err: unknown) => err);

      expect((failure as DpmwError).code).toBe("RELAY_TRANSACTION_NOT_FOUND");
    });

    it("reports a lookup 4xx other than 404 as RELAYER_REQUEST_FAILED, not RELAY_REJECTED", async () => {
      fetchMock.mockResolvedValue(new Response("nope", { status: 400 }));

      const failure = await client()
        .transaction("tx-1", FROM)
        .catch((err: unknown) => err);

      expect((failure as DpmwError).code).toBe("RELAYER_REQUEST_FAILED");
    });

    it("reports any other refusal as RELAYER_REQUEST_FAILED", async () => {
      fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

      const failure = await client()
        .transaction("tx-1", FROM)
        .catch((err: unknown) => err);

      expect((failure as DpmwError).code).toBe("RELAYER_REQUEST_FAILED");
    });
  });
});
