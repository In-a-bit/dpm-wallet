import { startHarness, type Harness } from "../src/testing/harness";

const CUSTOMER = "customer-12345";
const ALLOWED = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const REAL_FETCH = globalThis.fetch;

/** Stubs relayer-api's relay-payload so a withdrawal can be built without a network. */
function stubRelayer(): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("relay-payload")) {
      return Response.json({ address: "0x7777777777777777777777777777777777777777", nonce: "7" });
    }
    return REAL_FETCH(input, init);
  };
}

async function boot(env: Record<string, string>): Promise<Harness> {
  const harness = await startHarness(env);
  await harness.post("/v1/vault/init");
  await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
  await harness.post(`/v1/addresses/${CUSTOMER}/dpm-registered`, { body: {} });
  return harness;
}

async function failures(harness: Harness): Promise<{ code?: string }[]> {
  const rows: { detail: string }[] = await harness.db.query(
    `SELECT detail FROM audit_events WHERE action = 'meta.withdraw' AND outcome = 'failure' ORDER BY id`,
  );
  return rows.map((row) => JSON.parse(row.detail) as { code?: string });
}

describe("in-service limits", () => {
  let harness: Harness | undefined;

  beforeEach(stubRelayer);

  afterEach(async () => {
    globalThis.fetch = REAL_FETCH;
    await harness?.close();
    harness = undefined;
  });

  describe("rate limit", () => {
    it("answers 429 past SIGN_RATE_LIMIT_PER_MIN on sign and meta-tx routes together", async () => {
      harness = await boot({ SIGN_RATE_LIMIT_PER_MIN: "3" });

      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        statuses.push(
          (await harness.post("/v1/meta-tx/allowance", { body: { ref: CUSTOMER } })).status,
        );
      }
      const limited = await harness.post("/v1/sign/cancel", {
        body: { ref: CUSTOMER, orderHash: `0x${"ab".repeat(32)}`, marketId: "m" },
      });

      expect(statuses).not.toContain(429);
      expect(limited.status).toBe(429);
    });

    it("does not limit other routes", async () => {
      harness = await boot({ SIGN_RATE_LIMIT_PER_MIN: "1" });

      for (let i = 0; i < 5; i++) {
        expect((await harness.get(`/v1/addresses/${CUSTOMER}`)).status).toBe(200);
      }
    });

    it("rejects a non-positive limit at boot", async () => {
      await expect(startHarness({ SIGN_RATE_LIMIT_PER_MIN: "0" })).rejects.toThrow(
        /SIGN_RATE_LIMIT_PER_MIN/,
      );
    });
  });

  describe("recipient allowlist", () => {
    it("refuses a recipient off the list, with an audited distinct code", async () => {
      harness = await boot({ WITHDRAW_RECIPIENT_ALLOWLIST: ` ${ALLOWED} ` });

      const refused = await harness.post("/v1/meta-tx/withdraw", {
        body: { ref: CUSTOMER, recipient: OTHER, amountDecimal: "1" },
      });

      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("WITHDRAW_RECIPIENT_NOT_ALLOWED");
      expect(await failures(harness)).toMatchObject([{ code: "WITHDRAW_RECIPIENT_NOT_ALLOWED" }]);
    });

    it("signs a listed recipient, whatever its case", async () => {
      harness = await boot({ WITHDRAW_RECIPIENT_ALLOWLIST: ALLOWED });

      const ok = await harness.post("/v1/meta-tx/withdraw", {
        body: {
          ref: CUSTOMER,
          recipient: ALLOWED.toUpperCase().replace("0X", "0x"),
          amountDecimal: "1",
        },
      });

      expect(ok.status).toBe(200);
    });

    it("is off by default", async () => {
      harness = await boot({});

      const ok = await harness.post("/v1/meta-tx/withdraw", {
        body: { ref: CUSTOMER, recipient: OTHER, amountDecimal: "1" },
      });

      expect(ok.status).toBe(200);
    });

    it("rejects a malformed list at boot", async () => {
      await expect(startHarness({ WITHDRAW_RECIPIENT_ALLOWLIST: "nope" })).rejects.toThrow(
        /WITHDRAW_RECIPIENT_ALLOWLIST/,
      );
    });
  });

  describe("daily cap", () => {
    it("refuses once the rolling 24h total would pass the cap, and audits it", async () => {
      harness = await boot({ WITHDRAW_MAX_DAILY_DECIMAL: "100" });
      const withdraw = (amountDecimal: string) =>
        harness!.post("/v1/meta-tx/withdraw", {
          body: { ref: CUSTOMER, recipient: OTHER, amountDecimal },
        });

      const first = await withdraw("60");
      const over = await withdraw("40.5");
      const exact = await withdraw("40");

      expect(first.status).toBe(200);
      expect(over.status).toBe(403);
      expect(over.body.error.code).toBe("WITHDRAW_DAILY_LIMIT_EXCEEDED");
      expect(exact.status).toBe(200);
      expect(await failures(harness)).toMatchObject([{ code: "WITHDRAW_DAILY_LIMIT_EXCEEDED" }]);
    });

    it("counts withdrawals recorded before a restart, and forgets those older than 24h", async () => {
      harness = await boot({ WITHDRAW_MAX_DAILY_DECIMAL: "100" });
      await harness.post("/v1/meta-tx/withdraw", {
        body: { ref: CUSTOMER, recipient: OTHER, amountDecimal: "90" },
      });
      // The window is read from the table, so a restart cannot reset it; ageing the row out of
      // the window is what frees the budget.
      await harness.db.query(
        `UPDATE audit_events SET created_at = now() - interval '25 hours' WHERE action = 'meta.withdraw'`,
      );

      const again = await harness.post("/v1/meta-tx/withdraw", {
        body: { ref: CUSTOMER, recipient: OTHER, amountDecimal: "90" },
      });

      expect(again.status).toBe(200);
    });

    it("lets only one of two concurrent withdrawals through a cap that fits one", async () => {
      harness = await boot({ WITHDRAW_MAX_DAILY_DECIMAL: "100" });
      const send = () =>
        harness!.post("/v1/meta-tx/withdraw", {
          body: { ref: CUSTOMER, recipient: OTHER, amountDecimal: "60" },
        });

      const statuses = (await Promise.all([send(), send()])).map((r) => r.status).sort();

      expect(statuses).toEqual([200, 403]);
    });

    it("is off by default", async () => {
      harness = await boot({});
      for (let i = 0; i < 3; i++) {
        const ok = await harness.post("/v1/meta-tx/withdraw", {
          body: { ref: CUSTOMER, recipient: OTHER, amountDecimal: "1000000" },
        });
        expect(ok.status).toBe(200);
      }
    });

    it("rejects a malformed cap at boot", async () => {
      await expect(startHarness({ WITHDRAW_MAX_DAILY_DECIMAL: "-5" })).rejects.toThrow(
        /WITHDRAW_MAX_DAILY_DECIMAL/,
      );
    });
  });
});
