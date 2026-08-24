import type { FetchLike } from "@inabit-com/dpm-sdk/server";

/**
 * The header `relayer-api` resolves through `builderauth` for a builder's own backend. It
 * is a bearer secret, unlike the publishable `X-Builder-Api-Key` a browser may carry.
 */
export const BUILDER_API_PRIVATE_KEY_HEADER = "X-Builder-Api-Private-Key";

/**
 * Names the EOA the builder is acting for. `relayer-api` reads the pair — secret plus
 * address — on its authenticated routes, and confines a builder to the addresses it
 * onboarded; the secret alone reaches only the public reads such as GET /relay-payload.
 */
export const BUILDER_ADDRESS_HEADER = "X-Builder-Address";

/**
 * Wraps fetch so every SDK call to `relayer-api` carries the operator's builder secret and
 * the EOA it is acting for — and nothing else. The app-level `X-API-Key` is the DPM
 * platform's own credential, which this service neither holds nor sends.
 *
 * The credential is scoped to one wallet because a build only ever acts for one: GET
 * /redeem-outcome, which the redeem-to-recipient path quotes the payout from, resolves the
 * caller from this pair and rejects the secret on its own.
 *
 * Injecting the headers here rather than through the SDK's `RequestAuth` union keeps the
 * credential out of the SDK's surface entirely.
 */
export function createBuilderKeyFetch(builderApiKey: string, actingAddress: string): FetchLike {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set(BUILDER_API_PRIVATE_KEY_HEADER, builderApiKey);
    headers.set(BUILDER_ADDRESS_HEADER, actingAddress);
    return fetch(input, { ...init, headers });
  };
}
