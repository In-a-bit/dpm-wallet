import { mountApiDocsIfEnabled } from "../src/api-docs";
import { startHarness, type Harness } from "../src/testing/harness";
import { SwaggerModule } from "@nestjs/swagger";

const CUSTOMER = "customer-12345";
const SECRET_UPSTREAM_TEXT = "turnkey-internal-org-1234 policy denied";

describe("upstream error text", () => {
  let harness: Harness;
  let logged: string[];

  beforeEach(async () => {
    logged = [];
    const capture = (...args: unknown[]): void => {
      logged.push(String(args[0]));
    };
    jest.spyOn(console, "log").mockImplementation(capture);
    jest.spyOn(console, "error").mockImplementation(capture);
    harness = await startHarness();
    await harness.post("/v1/vault/init");
  });

  afterEach(async () => {
    await harness.close();
    jest.restoreAllMocks();
  });

  it("logs a Turnkey failure with a request id and returns only a generic message", async () => {
    await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
    await harness.post(`/v1/addresses/${CUSTOMER}/dpm-registered`, { body: {} });
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("relay-payload")) {
        return new Response(SECRET_UPSTREAM_TEXT, { status: 500 });
      }
      return original(input, init);
    };
    try {
      const response = await harness.post("/v1/meta-tx/allowance", { body: { ref: CUSTOMER } });

      expect(response.status).toBe(502);
      expect(JSON.stringify(response.body)).not.toContain("turnkey-internal");
      const requestId = response.body.error.requestId as string;
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      const line = logged.find((entry) => entry.includes(requestId)) ?? "";
      expect(line).toContain("turnkey-internal-org-1234");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("mounts the API docs only when enabled", () => {
    const setup = jest.spyOn(SwaggerModule, "setup").mockImplementation(() => undefined);

    mountApiDocsIfEnabled(harness.app, { enableApiDocs: false });
    expect(setup).not.toHaveBeenCalled();

    mountApiDocsIfEnabled(harness.app, { enableApiDocs: true });
    expect(setup).toHaveBeenCalledWith("v1/docs", harness.app, expect.anything());
  });
});
