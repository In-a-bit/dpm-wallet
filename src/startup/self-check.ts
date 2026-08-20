import {
  buildOrderTypedData,
  EXCHANGE_DOMAIN_NAME,
  SignatureType,
  type OrderFields,
} from "@inabit-com/dpm-sdk/server";
import { hashTypedData, type Hex, type TypedDataDefinition } from "viem";

import { DpmwError } from "../errors.js";
import { logInfo } from "../observability/log.js";

/**
 * A fixed order with fixed contract addresses, so its digest depends only on the EIP-712
 * domain assembly. Nothing about it is ever signed or submitted.
 */
const FIXTURE_ORDER: OrderFields = {
  salt: "1",
  maker: "0x1111111111111111111111111111111111111111",
  signer: "0x2222222222222222222222222222222222222222",
  taker: "0x0000000000000000000000000000000000000000",
  recipient: "0x0000000000000000000000000000000000000000",
  tokenId: "1",
  makerAmount: "40000000",
  takerAmount: "100000000",
  expiration: "0",
  nonce: "0",
  feeRateBps: "200",
  side: 0,
  signatureType: SignatureType.PROXY_WALLET,
};

const FIXTURE_CHAIN_ID = 137;
const FIXTURE_EXCHANGE = "0x3333333333333333333333333333333333333333";

/**
 * The digest the fixture must produce under the domain name `"DPM CTF Exchange"`.
 *
 * The name is not configurable — it is a property of the deployed exchange, and the SDK
 * owns it. What this pin guards is an SDK upgrade quietly changing it: a domain of, say,
 * `"Polymarket CTF Exchange"` produces perfectly valid signatures over the wrong digest,
 * and the exchange rejects every one of them with no indication of why. Better to refuse
 * to boot than to sign thousands of orders nothing will accept.
 */
const EXPECTED_DIGEST: Hex =
  "0x684e57d371183a06e4731e7f45fd191973d31aef4f8a0543f6d8053d33940f02";

export function assertExchangeDomain(): void {
  const digest = fixtureDigest(EXCHANGE_DOMAIN_NAME);
  if (digest !== EXPECTED_DIGEST) {
    throw new DpmwError(
      "INTERNAL_ERROR",
      `EIP-712 self-check failed: fixture digest ${digest} does not match the pinned value. ` +
        `The SDK's exchange domain name is "${EXCHANGE_DOMAIN_NAME}".`,
    );
  }
  logInfo("startup.self_check_passed", { exchangeDomainName: EXCHANGE_DOMAIN_NAME });
}

export function fixtureDigest(domainName: string): Hex {
  const typedData = buildOrderTypedData(
    FIXTURE_ORDER,
    FIXTURE_CHAIN_ID,
    FIXTURE_EXCHANGE,
    domainName,
  ) as TypedDataDefinition;
  return hashTypedData(typedData);
}
