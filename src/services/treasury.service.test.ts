import { parseTransaction } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startHarness, type Harness } from "../testing/harness.js";

const CUSTOMER = "customer-12345";
const EXTERNAL = "0x9999999999999999999999999999999999999999";
const COLLATERAL = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/** Supplied by the operator: this service configures no RPC, so it cannot read either. */
const CHAIN = {
  nonce: 3,
  gasLimit: "120000",
  maxFeePerGas: "50000000000",
  maxPriorityFeePerGas: "30000000000",
};

/**
 * Three movements are legitimate: the master funds a user's proxy, the master pays an
 * external address, and a user's EOA is swept back to the master. Managed EOAs are signing
 * keys, so nothing may be sent to one on purpose.
 */
describe("treasury signing", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
    await harness.post("/v1/vault/init");
    await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
  });

  afterEach(async () => {
    await harness.close();
  });

  const customer = () => harness.get(`/v1/addresses/${CUSTOMER}`);
  const master = () => harness.get("/v1/addresses/master");

  describe("funding a user's proxy", () => {
    it("signs an ERC-20 transfer from the master to the user's proxy", async () => {
      const response = await harness.post("/v1/treasury/fund-proxy", {
        body: { to: CUSTOMER, amountDecimal: "250.5", chain: CHAIN },
      });

      expect(response.status).toBe(200);
      const tx = parseTransaction(response.body.signedTransaction);
      expect(tx.to).toBe(COLLATERAL.toLowerCase());
      // A zero value is RLP-encoded as an empty field, which viem reports as absent.
      expect(tx.value ?? 0n).toBe(0n);
      expect(tx.nonce).toBe(CHAIN.nonce);
      // transfer(address,uint256) with 250.5 USDC in 6-decimal micro-units.
      expect(tx.data).toContain("a9059cbb");
      expect(tx.data?.endsWith((250_500_000).toString(16).padStart(64, "0"))).toBe(true);
    });

    it("targets the proxy, not the EOA, and signs with the master", async () => {
      const { body: user } = await customer();
      const { body: treasury } = await master();
      const response = await harness.post("/v1/treasury/fund-proxy", {
        body: { to: CUSTOMER, amountDecimal: "10", chain: CHAIN },
      });

      expect(response.body.from).toBe(treasury.address);
      expect(response.body.signedTransaction.toLowerCase()).toContain(
        user.proxyAddress.slice(2).toLowerCase(),
      );
      expect(response.body.signedTransaction.toLowerCase()).not.toContain(
        user.address.slice(2).toLowerCase(),
      );
    });

    it("records the credit under the user, not the master that signed it", async () => {
      await harness.post("/v1/treasury/fund-proxy", {
        body: { to: CUSTOMER, amountDecimal: "10", chain: CHAIN },
      });
      const audit = await harness.get(`/v1/audit?ref=${CUSTOMER}&action=treasury.fund_proxy`);

      expect(audit.body.total).toBe(1);
    });

    it("refuses to fund the master's own proxy", async () => {
      const response = await harness.post("/v1/treasury/fund-proxy", {
        body: { to: "master", amountDecimal: "10", chain: CHAIN },
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("POLICY_VIOLATION");
    });
  });

  describe("external withdrawal", () => {
    it("signs a master withdrawal to an unmanaged address", async () => {
      const response = await harness.post("/v1/treasury/external-withdraw", {
        body: { destination: EXTERNAL, amountDecimal: "100", chain: CHAIN },
      });

      expect(response.status).toBe(200);
      expect(response.body.signedTransaction).toMatch(/^0x02/);
    });

    it("signs a native withdrawal with 18 decimals", async () => {
      const response = await harness.post("/v1/treasury/external-withdraw", {
        body: { destination: EXTERNAL, asset: "native", amountDecimal: "1.5", chain: CHAIN },
      });

      const tx = parseTransaction(response.body.signedTransaction);
      expect(tx.to?.toLowerCase()).toBe(EXTERNAL.toLowerCase());
      expect(tx.value).toBe(1_500_000_000_000_000_000n);
    });

    // Managed EOAs hold no balance by design, so crediting one would strand the funds
    // somewhere only a sweep could recover them from.
    it("refuses a managed EOA as the destination", async () => {
      const { body: user } = await customer();
      const response = await harness.post("/v1/treasury/external-withdraw", {
        body: { destination: user.address, amountDecimal: "10", chain: CHAIN },
      });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toContain("managed EOA");
    });

    it("refuses a managed proxy as the destination", async () => {
      const { body: user } = await customer();
      const response = await harness.post("/v1/treasury/external-withdraw", {
        body: { destination: user.proxyAddress, amountDecimal: "10", chain: CHAIN },
      });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toContain("/v1/treasury/fund-proxy");
    });
  });

  describe("sweeping a stray balance", () => {
    it("signs from the user's EOA to the master", async () => {
      const { body: treasury } = await master();
      const { body: user } = await customer();
      const response = await harness.post("/v1/treasury/sweep", {
        body: { from: CUSTOMER, asset: "native", amountDecimal: "0.25", chain: CHAIN },
      });

      expect(response.status).toBe(200);
      expect(response.body.from).toBe(user.address);
      const tx = parseTransaction(response.body.signedTransaction);
      expect(tx.to?.toLowerCase()).toBe(treasury.address.toLowerCase());
      expect(tx.value).toBe(250_000_000_000_000_000n);
    });

    it("sweeps USDC as an ERC-20 transfer to the master", async () => {
      const { body: treasury } = await master();
      const response = await harness.post("/v1/treasury/sweep", {
        body: { from: CUSTOMER, asset: "usdc", amountDecimal: "5", chain: CHAIN },
      });

      const tx = parseTransaction(response.body.signedTransaction);
      expect(tx.to).toBe(COLLATERAL.toLowerCase());
      expect(tx.data?.toLowerCase()).toContain(treasury.address.slice(2).toLowerCase());
    });

    // The master pays out through external-withdraw; a sweep only ever runs towards it.
    it("refuses the master as the source", async () => {
      const response = await harness.post("/v1/treasury/sweep", {
        body: { from: "master", amountDecimal: "10", chain: CHAIN },
      });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toContain("/v1/treasury/external-withdraw");
    });
  });
});
