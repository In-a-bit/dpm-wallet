import { hashTypedData, recoverAddress, verifyMessage } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startHarness, type Harness } from "../testing/harness.js";

const CUSTOMER = "customer-12345";
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const CHAIN_ID = 137;
const TOKEN_ID = "71321045679252212594626385532706912750332728571942532289631379312455583992563";

const ORDER = {
  ref: CUSTOMER,
  side: 0,
  tokenId: TOKEN_ID,
  shares: 100,
  price: 0.55,
  feeRateBps: 0,
};

describe("order signing", () => {
  let harness: Harness;
  let proxyAddress: string;
  let eoaAddress: string;

  beforeEach(async () => {
    harness = await startHarness();
    await harness.post("/v1/vault/init");
    const created = await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
    proxyAddress = created.body.proxyAddress;
    eoaAddress = created.body.address;
  });

  afterEach(async () => {
    await harness.close();
  });

  it("signs with the EOA while the maker stays the operator-supplied address", async () => {
    const response = await harness.post("/v1/sign/order", {
      body: { ...ORDER, maker: proxyAddress },
    });

    expect(response.status).toBe(200);
    expect(response.body.order).toMatchObject({
      maker: proxyAddress,
      signer: eoaAddress,
      tokenId: TOKEN_ID,
      side: 0,
      feeRateBps: "0",
    });
    // PROXY_WALLET: the exchange must be told the signer owns the maker proxy rather than being
    // the funds holder itself, or it would recover the signature against the maker and reject it.
    expect(response.body.order.signatureType).toBe(1);
  });

  it("converts shares and price into 6-decimal exchange amounts", async () => {
    const response = await harness.post("/v1/sign/order", {
      body: { ...ORDER, maker: proxyAddress },
    });
    // A buy of 100 shares at 0.55 pays 55 USDC to receive 100 outcome tokens.
    expect(response.body.order).toMatchObject({
      makerAmount: "55000000",
      takerAmount: "100000000",
    });
  });

  it("produces a signature the exchange can recover to the signer", async () => {
    const response = await harness.post("/v1/sign/order", {
      body: { ...ORDER, maker: proxyAddress },
    });
    const order = response.body.order;

    const digest = hashTypedData({
      domain: {
        name: "DPM CTF Exchange",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: CTF_EXCHANGE,
      },
      types: {
        Order: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "address" },
          { name: "signer", type: "address" },
          { name: "taker", type: "address" },
          { name: "recipient", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "makerAmount", type: "uint256" },
          { name: "takerAmount", type: "uint256" },
          { name: "expiration", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "feeRateBps", type: "uint256" },
          { name: "side", type: "uint8" },
          { name: "signatureType", type: "uint8" },
        ],
      },
      primaryType: "Order",
      message: {
        salt: BigInt(order.salt),
        maker: order.maker,
        signer: order.signer,
        taker: order.taker,
        recipient: order.recipient,
        tokenId: BigInt(order.tokenId),
        makerAmount: BigInt(order.makerAmount),
        takerAmount: BigInt(order.takerAmount),
        expiration: BigInt(order.expiration),
        nonce: BigInt(order.nonce),
        feeRateBps: BigInt(order.feeRateBps),
        side: order.side,
        signatureType: order.signatureType,
      },
    });

    expect(response.body.orderHash).toBe(digest);
    const recovered = await recoverAddress({ hash: digest, signature: response.body.signature });
    expect(recovered).toBe(eoaAddress);
  });

  // The salt is what lets a client place the same economic order twice.
  it("gives each order a distinct salt and hash", async () => {
    const first = await harness.post("/v1/sign/order", { body: { ...ORDER, maker: proxyAddress } });
    const second = await harness.post("/v1/sign/order", {
      body: { ...ORDER, maker: proxyAddress },
    });
    expect(first.body.order.salt).not.toBe(second.body.order.salt);
    expect(first.body.orderHash).not.toBe(second.body.orderHash);
  });

  it("signs a sell order in the opposite direction", async () => {
    const response = await harness.post("/v1/sign/order", {
      body: { ...ORDER, maker: proxyAddress, side: 1 },
    });
    expect(response.body.order).toMatchObject({
      side: 1,
      makerAmount: "100000000",
      takerAmount: "55000000",
    });
  });

  // Only the proceeds are redirected: the maker remains the source of funds and keeps cancel
  // rights, so `maker` must survive a recipient being set.
  it("carries an explicit recipient through to the signed order", async () => {
    const recipient = "0x9999999999999999999999999999999999999999";
    const response = await harness.post("/v1/sign/order", {
      body: { ...ORDER, maker: proxyAddress, recipient },
    });
    expect(response.body.order.recipient).toBe(recipient);
    expect(response.body.order.maker).toBe(proxyAddress);
  });

  it("defaults the recipient to zero, which the exchange reads as paying the maker", async () => {
    const response = await harness.post("/v1/sign/order", {
      body: { ...ORDER, maker: proxyAddress },
    });
    expect(response.body.order.recipient).toBe("0x0000000000000000000000000000000000000000");
  });

  it("rejects an order for an unknown ref", async () => {
    const response = await harness.post("/v1/sign/order", {
      body: { ...ORDER, ref: "customer-99999", maker: proxyAddress },
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ADDRESS_NOT_FOUND");
  });

  it("rejects a price outside the tradeable range", async () => {
    const response = await harness.post("/v1/sign/order", {
      body: { ...ORDER, maker: proxyAddress, price: 1.5 },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  describe("cancellations", () => {
    const orderHash = "0x" + "ab".repeat(32);
    const marketId = "0x" + "cd".repeat(32);

    it("signs the cancel text as an EIP-191 personal message", async () => {
      const response = await harness.post("/v1/sign/cancel", {
        body: { ref: CUSTOMER, orderHash, marketId },
      });

      expect(response.status).toBe(200);
      expect(response.body.signer).toBe(eoaAddress);
      expect(
        await verifyMessage({
          address: eoaAddress as `0x${string}`,
          message: response.body.message,
          signature: response.body.signature,
        }),
      ).toBe(true);
    });

    it("includes both identifiers in the signed text so it cannot be replayed elsewhere", async () => {
      const response = await harness.post("/v1/sign/cancel", {
        body: { ref: CUSTOMER, orderHash, marketId },
      });
      expect(response.body.message).toContain(orderHash);
      expect(response.body.message).toContain(marketId);
    });
  });
});
