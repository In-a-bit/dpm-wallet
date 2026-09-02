import { LP_ATTESTATION_MESSAGE } from "@inabit-com/dpm-sdk/turnkey";
import { recoverMessageAddress } from "viem";

import { DpmwError } from "../src/errors";
import { startHarness, type Harness } from "../src/testing/harness";

const CUSTOMER = "customer-12345";

/**
 * Registration is the one flow that reaches all the way to the DPM platform: dpm-wallet signs
 * the attestation, posts it to gamma-api's custody onboarding, and only then records the flag
 * that meta-transaction signing gates on. The tests below pin the parts an operator cannot
 * see — that the signature is one gamma-api would accept, that a second call costs nothing,
 * and that a platform that says no leaves the flag alone rather than half-set.
 */
describe("POST /v1/addresses/:ref/dpm-register", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
    await harness.post("/v1/vault/init");
    await harness.post("/v1/addresses", { body: { ref: CUSTOMER } });
  });

  afterEach(async () => {
    await harness.close();
  });

  it("registers the address with dpm-api and records the flag", async () => {
    const response = await harness.post(`/v1/addresses/${CUSTOMER}/dpm-register`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ref: CUSTOMER, dpmRegistered: true });

    const stored = await harness.wallets.findByRef(CUSTOMER);
    expect(stored?.dpmRegistered).toBe(true);
  });

  // gamma-api recovers the signer to decide whether the caller controls the address it is
  // onboarding, so a signature that does not recover to this wallet's own EOA is one the
  // platform would reject.
  it("sends an attestation that recovers to the wallet's own EOA", async () => {
    const created = await harness.get(`/v1/addresses/${CUSTOMER}`);

    await harness.post(`/v1/addresses/${CUSTOMER}/dpm-register`);

    expect(harness.gammaApi.custodyRequests).toHaveLength(1);
    const registration = harness.gammaApi.custodyRequests[0]!;
    expect(registration.address.toLowerCase()).toBe(created.body.address.toLowerCase());
    const signer = await recoverMessageAddress({
      message: LP_ATTESTATION_MESSAGE,
      signature: registration.signature,
    });
    expect(signer.toLowerCase()).toBe(created.body.address.toLowerCase());
  });

  // gamma-api is idempotent per address, so a second post would be harmless — but the flag is
  // already set, and re-signing an attestation to be told what we know is a round trip to the
  // platform for nothing. Provisioning retries land here, so it is worth not making.
  it("does not call gamma-api again once the address is registered", async () => {
    await harness.post(`/v1/addresses/${CUSTOMER}/dpm-register`);
    const repeat = await harness.post(`/v1/addresses/${CUSTOMER}/dpm-register`);

    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ ref: CUSTOMER, dpmRegistered: true });
    expect(harness.gammaApi.custodyRequests).toHaveLength(1);
  });

  // The flag is what meta-transaction signing gates on. Setting it when the platform never
  // acknowledged the address would produce a wallet that passes our own check and then fails
  // at the relayer, which is the one failure mode this endpoint exists to prevent.
  it("leaves the flag unset when gamma-api cannot be reached", async () => {
    harness.gammaApi.failWith = new DpmwError(
      "RELAYER_REQUEST_FAILED",
      "gamma-api /custody/users is unreachable",
    );

    const response = await harness.post(`/v1/addresses/${CUSTOMER}/dpm-register`);

    expect(response.status).toBe(502);
    const stored = await harness.wallets.findByRef(CUSTOMER);
    expect(stored?.dpmRegistered).toBe(false);
  });

  // gamma-api derives the proxy from its own factory and implementation addresses. A disagreement
  // means the two services are pointed at different factories, so the platform has onboarded a
  // proxy this vault will never sign for — worth failing on rather than recording as success.
  it("refuses to record a registration whose proxy disagrees with ours", async () => {
    harness.gammaApi.proxyWalletOverride = "0x000000000000000000000000000000000000dEaD";

    const response = await harness.post(`/v1/addresses/${CUSTOMER}/dpm-register`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("DPM_REGISTRATION_REJECTED");
    const stored = await harness.wallets.findByRef(CUSTOMER);
    expect(stored?.dpmRegistered).toBe(false);
  });
});
