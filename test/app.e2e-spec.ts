import { LP_ATTESTATION_MESSAGE } from "@inabit-com/dpm-sdk/turnkey";
import { recoverMessageAddress } from "viem";
import { startHarness, type Harness } from "../src/testing/harness";

const CUSTOMER = "customer-12345";
const MAKER = "0x1111111111111111111111111111111111111111";

const ORDER_REQUEST = {
  ref: CUSTOMER,
  maker: MAKER,
  side: 0,
  tokenId: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
  shares: 100,
  price: 0.4,
  feeRateBps: 200,
};

describe("dpm-wallet HTTP API", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  describe("authentication", () => {
    it("serves health without a key, per the prediction-gateway convention", async () => {
      const response = await harness.get("/v1/health", { apiKey: null });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ok");
    });

    it("rejects a missing key", async () => {
      const response = await harness.get("/v1/vault/status", { apiKey: null });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("rejects a wrong key", async () => {
      const response = await harness.get("/v1/vault/status", { apiKey: "nope" });
      expect(response.status).toBe(401);
    });
  });

  describe("before vault init", () => {
    it("reports the vault as uninitialized", async () => {
      const response = await harness.get("/v1/vault/status");
      expect(response.body).toMatchObject({ mode: "turnkey", initialized: false });
    });

    it("refuses address creation", async () => {
      const response = await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("VAULT_NOT_INITIALIZED");
    });
  });

  describe("after vault init", () => {
    beforeEach(async () => {
      await harness.post("/v1/vault/init");
    });

    it("adopts the sub-organisation", async () => {
      const response = await harness.get("/v1/vault/status");
      expect(response.body).toMatchObject({ initialized: true });
      expect(response.body.subOrgName).toBe("dpm-builder-1-fake-1");
    });

    // Re-running init must write nothing: the state row is immutable and makes its one
    // transition on the first call.
    it("is idempotent and appends no second set of records", async () => {
      const first = await harness.get("/v1/vault/status");
      const repeat = await harness.post("/v1/vault/init");
      const second = await harness.get("/v1/vault/status");

      expect(repeat.status).toBe(200);
      expect(second.body.subOrgName).toBe(first.body.subOrgName);

      const audit = await harness.get("/v1/audit?action=vault.init");
      expect(audit.body.total).toBe(1);
    });

    describe("addresses", () => {
      it("allocates wallets from index 0 with a derived proxy", async () => {
        const first = await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
        const second = await harness.post("/v1/addresses", { body: { ref: "customer-2" } });

        expect(first.body).toMatchObject({ ref: CUSTOMER, index: 0, dpmRegistered: false });
        expect(first.body.proxyAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(first.body.proxyAddress).not.toBe(first.body.address);
        expect(second.body.index).toBe(1);
      });

      // Reusing a ref is a mistake on the operator's side. Returning the existing wallet
      // would let a bug map two customers onto one key without anyone noticing.
      it("rejects a ref that already has an address", async () => {
        await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
        const again = await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });

        expect(again.status).toBe(409);
        expect(again.body.error.code).toBe("REF_ALREADY_EXISTS");
      });

      // gamma-api recovers the signer from this signature to decide whether the caller
      // controls the address it is registering, so anything that does not recover to the
      // wallet's own EOA would be rejected there.
      it("attests control of an address with a recoverable signature", async () => {
        const created = await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
        const response = await harness.post(`/v1/addresses/${CUSTOMER}/dpm-attestation`);

        expect(response.status).toBe(200);
        expect(response.body.address).toBe(created.body.address);
        const signer = await recoverMessageAddress({
          message: LP_ATTESTATION_MESSAGE,
          signature: response.body.signature,
        });
        expect(signer.toLowerCase()).toBe(created.body.address.toLowerCase());
      });

      it("reports an unknown ref as ADDRESS_NOT_FOUND", async () => {
        const response = await harness.get("/v1/addresses/nobody");
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe("ADDRESS_NOT_FOUND");
      });

      it("rejects a request with no ref", async () => {
        const response = await harness.post("/v1/addresses", { body: {} });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("VALIDATION_FAILED");
      });
    });

    describe("order signing", () => {
      beforeEach(async () => {
        await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
      });

      it("signs the operator's maker and this service's signer", async () => {
        const created = await harness.get(`/v1/addresses/${CUSTOMER}`);
        const response = await harness.post("/v1/sign/order", { body: ORDER_REQUEST });

        expect(response.status).toBe(200);
        expect(response.body.order).toMatchObject({
          maker: MAKER,
          signer: created.body.address,
          taker: "0x0000000000000000000000000000000000000000",
          // An omitted recipient is encoded as zero, which the exchange reads as "pay the maker".
          recipient: "0x0000000000000000000000000000000000000000",
          makerAmount: "40000000",
          takerAmount: "100000000",
          feeRateBps: "200",
          signatureType: 1,
        });
        expect(response.body.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
      });

      it("signs the operator's recipient as supplied, without validating it", async () => {
        const unknownRecipient = "0x9999999999999999999999999999999999999999";
        const response = await harness.post("/v1/sign/order", {
          body: { ...ORDER_REQUEST, recipient: unknownRecipient },
        });
        expect(response.body.order.recipient).toBe(unknownRecipient);
      });

      it("signs a cancel message", async () => {
        const response = await harness.post("/v1/sign/cancel", {
          body: { ref: CUSTOMER, orderHash: `0x${"ab".repeat(32)}`, marketId: "market-1" },
        });
        expect(response.status).toBe(200);
        expect(response.body.message).toBe(
          `Cancel order: 0x${"ab".repeat(32)} on market: market-1`,
        );
      });
    });

    describe("meta-transactions", () => {
      beforeEach(async () => {
        await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
      });

      // GET /relay-payload resolves the RelayHub nonce from the DPM users table, so an EOA the DPM platform
      // has never seen cannot yield one. Surfacing that as its own code lets the operator tell it
      // apart from a genuine signing failure.
      it("refuses to sign for a wallet the DPM platform has not registered", async () => {
        const response = await harness.post("/v1/meta-tx/allowance", { body: { ref: CUSTOMER } });
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe("CUSTOMER_NOT_REGISTERED");
      });

      it("validates per-kind arguments", async () => {
        await harness.post(`/v1/addresses/${CUSTOMER}/dpm-registered`, { body: {} });
        const response = await harness.post("/v1/meta-tx/redeem", { body: { ref: CUSTOMER } });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("VALIDATION_FAILED");
      });
    });

    describe("idempotency", () => {
      it("replays the stored response for a repeated key and body", async () => {
        const first = await harness.post("/v1/addresses", {
          body: { ref: CUSTOMER },
          idempotencyKey: "key-1",
        });
        const replay = await harness.post("/v1/addresses", {
          body: { ref: CUSTOMER },
          idempotencyKey: "key-1",
        });
        expect(replay.body).toEqual(first.body);
      });

      it("rejects the same key with a different body", async () => {
        await harness.post("/v1/addresses", {
          body: { ref: CUSTOMER },
          idempotencyKey: "key-1",
        });
        const conflict = await harness.post("/v1/addresses", {
          body: { ref: "someone-else" },
          idempotencyKey: "key-1",
        });
        expect(conflict.status).toBe(409);
        expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
      });

      // Two signings of the same order differ by salt, so without a stored response a retried
      // request would hand the operator a second, unrelated signature for one intended order.
      it("returns the original signature when an order request is retried", async () => {
        await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
        const first = await harness.post("/v1/sign/order", {
          body: ORDER_REQUEST,
          idempotencyKey: "order-1",
        });
        const replay = await harness.post("/v1/sign/order", {
          body: ORDER_REQUEST,
          idempotencyKey: "order-1",
        });
        expect(replay.body.signature).toBe(first.body.signature);
        expect(replay.body.order.salt).toBe(first.body.order.salt);
      });
    });

    describe("audit", () => {
      it("records address creation and order signing", async () => {
        await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
        await harness.post("/v1/sign/order", { body: ORDER_REQUEST });

        const response = await harness.get(`/v1/audit?ref=${CUSTOMER}`);
        const actions = response.body.events.map((event: { action: string }) => event.action);
        expect(actions).toContain("address.create");
        expect(actions).toContain("sign.order");
      });

      it("truncates the signature it stores", async () => {
        await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
        const signed = await harness.post("/v1/sign/order", { body: ORDER_REQUEST });

        const response = await harness.get(`/v1/audit?ref=${CUSTOMER}&action=sign.order`);
        const stored = response.body.events[0].detail.signature;
        expect(stored).not.toBe(signed.body.signature);
        expect(signed.body.signature.startsWith(stored.replace("…", ""))).toBe(true);
      });
    });
  });
});
