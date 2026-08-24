import { createProxyStructHash } from "@inabit-com/dpm-sdk/server";
import { hashMessage, recoverAddress } from "viem";
import { BUILDER_ADDRESS_HEADER, BUILDER_API_PRIVATE_KEY_HEADER } from "../sdk/builder-key-fetch";
import { startHarness, type Harness } from "../testing/harness";

const CUSTOMER = "customer-12345";
const RELAY_ADDRESS = "0x7777777777777777777777777777777777777777";
const RELAY_NONCE = "7";
const CONDITION_ID = `0x${"cd".repeat(32)}`;
const PAYOUT_RECIPIENT = "0x8888888888888888888888888888888888888888";
/** Collateral base units the stubbed relayer quotes for a resolved condition. */
const PAYOUT = "1250000";
const TRANSFER_SELECTOR = "a9059cbb"; // transfer(address,uint256)

const RELAY_HUB = "0xd216153c06e857Cd7F72665e0aF1D7d82172f495";
const PROXY_FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";

/** Captured before any stub replaces it, so `afterEach` restores the genuine implementation. */
const REAL_FETCH = globalThis.fetch;

describe("meta-transaction signing", () => {
  let harness: Harness;
  let relayRequests: { url: string; headers: Headers }[];

  beforeEach(async () => {
    relayRequests = [];
    stubRelayPayload(relayRequests);
    harness = await startHarness();
    await harness.post("/v1/vault/init");
    await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
    await harness.post(`/v1/addresses/${CUSTOMER}/dpm-registered`, { body: {} });
  });

  afterEach(async () => {
    globalThis.fetch = REAL_FETCH;
    await harness.close();
  });

  it("returns a submit-ready body the operator can POST verbatim", async () => {
    const wallet = await harness.get(`/v1/addresses/${CUSTOMER}`);
    const response = await harness.post("/v1/meta-tx/allowance", { body: { ref: CUSTOMER } });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      from: wallet.body.address,
      to: PROXY_FACTORY,
      proxyWallet: wallet.body.proxyAddress,
      nonce: RELAY_NONCE,
      type: "PROXY",
      metadata: "approve USDC + setApprovalForAll CTF exchange",
      signatureParams: {
        gasPrice: "0",
        relayerFee: "0",
        gasLimit: "300000",
        relayHub: RELAY_HUB,
        relay: RELAY_ADDRESS,
      },
    });
  });

  // The rlx: preimage is reassembled by the RelayHub from the fields in the body. Recovering the
  // signer from a locally recomputed hash is the only way to catch a preimage that drifted.
  it("signs the rlx: struct hash with the wallet's EOA", async () => {
    const wallet = await harness.get(`/v1/addresses/${CUSTOMER}`);
    const body = (await harness.post("/v1/meta-tx/allowance", { body: { ref: CUSTOMER } })).body;

    const structHash = createProxyStructHash(
      body.from,
      body.to,
      body.data,
      body.signatureParams.relayerFee,
      body.signatureParams.gasPrice,
      body.signatureParams.gasLimit,
      body.nonce,
      body.signatureParams.relayHub,
      body.signatureParams.relay,
    );
    const recovered = await recoverAddress({
      hash: hashMessage({ raw: structHash }),
      signature: body.signature,
    });
    expect(recovered).toBe(wallet.body.address);
  });

  it("authenticates relay-payload with the builder secret and nothing else", async () => {
    await harness.post("/v1/meta-tx/allowance", { body: { ref: CUSTOMER } });

    const [request] = relayRequests;
    expect(request?.url).toContain("/relay-payload?address=");
    expect(request?.url).toContain("type=PROXY");
    expect(request?.headers.get(BUILDER_API_PRIVATE_KEY_HEADER)).toBe("bld_sk_test");
    expect(request?.headers.get("x-api-key")).toBeNull();
    expect(request?.headers.get("authorization")).toBeNull();
  });

  it("batches three approvals into the allowance call", async () => {
    const body = (await harness.post("/v1/meta-tx/allowance", { body: { ref: CUSTOMER } })).body;
    expect(occurrencesOf(body.data, "095ea7b3")).toBe(2); // approve(address,uint256)
    expect(occurrencesOf(body.data, "a22cb465")).toBe(1); // setApprovalForAll(address,bool)
  });

  // A redeem without a recipient stays a single CTF call, so the transfer below is what
  // distinguishes the two shapes the one endpoint now builds.
  it("redeems without forwarding when no recipient is named", async () => {
    const body = (
      await harness.post("/v1/meta-tx/redeem", {
        body: { ref: CUSTOMER, conditionId: CONDITION_ID },
      })
    ).body;

    expect(body.metadata).toBe("redeem");
    expect(occurrencesOf(body.data, TRANSFER_SELECTOR)).toBe(0);
  });

  it("forwards the quoted payout when a recipient is named", async () => {
    stubRedeemOutcome();
    const response = await harness.post("/v1/meta-tx/redeem", {
      body: { ref: CUSTOMER, conditionId: CONDITION_ID, recipient: PAYOUT_RECIPIENT },
    });

    expect(response.status).toBe(200);
    expect(response.body.metadata).toBe("redeem + transfer payout to recipient");
    expect(occurrencesOf(response.body.data, TRANSFER_SELECTOR)).toBe(1);
    // The extra call needs headroom the redeem-only limit does not carry.
    expect(response.body.signatureParams.gasLimit).toBe("450000");
  });

  // The quote is read from an authenticated route, which resolves the caller from the builder
  // secret and the address together — the secret alone reaches only the public reads.
  it("names the acting EOA on the payout quote", async () => {
    const quotes = stubRedeemOutcome();
    const wallet = await harness.get(`/v1/addresses/${CUSTOMER}`);
    await harness.post("/v1/meta-tx/redeem", {
      body: { ref: CUSTOMER, conditionId: CONDITION_ID, recipient: PAYOUT_RECIPIENT },
    });

    const [quote] = quotes;
    expect(quote?.url).toContain(`conditionId=${CONDITION_ID}`);
    expect(quote?.headers.get(BUILDER_API_PRIVATE_KEY_HEADER)).toBe("bld_sk_test");
    expect(quote?.headers.get(BUILDER_ADDRESS_HEADER)).toBe(wallet.body.address);
  });

  // Signing a transfer of a payout that will not arrive would revert the share burn with it.
  it("refuses to forward a payout the market has not resolved", async () => {
    stubRedeemOutcome(() => Response.json({ resolved: false, payout: "0" }));
    const response = await harness.post("/v1/meta-tx/redeem", {
      body: { ref: CUSTOMER, conditionId: CONDITION_ID, recipient: PAYOUT_RECIPIENT },
    });

    expect(response.status).toBe(400);
  });

  it("builds each kind with its own metadata", async () => {
    const redeem = await harness.post("/v1/meta-tx/redeem", {
      body: { ref: CUSTOMER, conditionId: CONDITION_ID },
    });
    const split = await harness.post("/v1/meta-tx/split", {
      body: { ref: CUSTOMER, conditionId: CONDITION_ID, amountDecimal: "10" },
    });
    const withdraw = await harness.post("/v1/meta-tx/withdraw", {
      body: {
        ref: CUSTOMER,
        recipient: "0x9999999999999999999999999999999999999999",
        amountDecimal: "5.5",
      },
    });

    expect(redeem.body.metadata).toBe("redeem");
    expect(split.body.metadata).toBe("split");
    expect(withdraw.body.metadata).toBe("funwithdraw");
  });

  // The code stays generic: all this service learns is that the call did not succeed, not
  // whether relayer-api was down, refused the credential, or rejected the request.
  it("reports an upstream relay-payload failure as RELAYER_REQUEST_FAILED", async () => {
    stubRelayPayload(relayRequests, () => new Response("boom", { status: 503 }));
    const response = await harness.post("/v1/meta-tx/allowance", { body: { ref: CUSTOMER } });
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("RELAYER_REQUEST_FAILED");
  });

  it("records the failure in the audit trail before surfacing it", async () => {
    stubRelayPayload(relayRequests, () => new Response("boom", { status: 503 }));
    await harness.post("/v1/meta-tx/allowance", { body: { ref: CUSTOMER } });

    const audit = await harness.get(`/v1/audit?ref=${CUSTOMER}&action=meta.allowance`);
    expect(audit.body.events[0]).toMatchObject({ outcome: "failure" });
  });

  // relayer-api resolves the nonce from the DPM users table and reports a missing user as a 500,
  // so the distinction has to be recovered from the body rather than the status.
  it("maps an unknown EOA upstream to CUSTOMER_NOT_REGISTERED", async () => {
    stubRelayPayload(
      relayRequests,
      () => new Response("user not found for address 0x…", { status: 500 }),
    );
    const response = await harness.post("/v1/meta-tx/allowance", { body: { ref: CUSTOMER } });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CUSTOMER_NOT_REGISTERED");
  });
});

/**
 * Intercepts only the relay-payload read and passes everything else through, so the service's own
 * outbound call is controlled without disturbing unrelated traffic.
 */
function stubRelayPayload(
  captured: { url: string; headers: Headers }[],
  respond: () => Response = () => Response.json({ address: RELAY_ADDRESS, nonce: RELAY_NONCE }),
): void {
  // Chains to whatever is installed now, so a test may narrow the stub the beforeEach set up.
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!url.includes("/relay-payload")) return previousFetch(input, init);
    captured.push({ url, headers: new Headers(init?.headers) });
    return respond();
  };
}

/**
 * Intercepts the payout quote the redeem-to-recipient path reads before signing, and returns
 * the captured requests so a test can assert on how it was authenticated.
 */
function stubRedeemOutcome(
  respond: () => Response = () =>
    Response.json({
      conditionId: CONDITION_ID,
      proxyWallet: "0x0000000000000000000000000000000000000000",
      resolved: true,
      payout: PAYOUT,
    }),
): { url: string; headers: Headers }[] {
  const captured: { url: string; headers: Headers }[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!url.includes("/redeem-outcome")) return previousFetch(input, init);
    captured.push({ url, headers: new Headers(init?.headers) });
    return respond();
  };
  return captured;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function occurrencesOf(data: string, selector: string): number {
  return data.split(selector).length - 1;
}
