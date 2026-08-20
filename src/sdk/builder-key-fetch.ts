import type { FetchLike } from "@inabit-com/dpm-sdk/server";

/**
 * The header `relayer-api` resolves through `builderauth` for a builder's own backend. It
 * is a bearer secret, unlike the publishable `X-Builder-Api-Key` a browser may carry.
 */
export const BUILDER_API_PRIVATE_KEY_HEADER = "X-Builder-Api-Private-Key";

/**
 * Wraps fetch so every SDK call to `relayer-api` carries the operator's builder secret —
 * and nothing else. The app-level `X-API-Key` is the DPM platform's own credential, which this
 * service neither holds nor sends.
 *
 * Injecting the header here rather than through the SDK's `RequestAuth` union keeps the
 * credential out of the SDK's surface entirely.
 */
export function createBuilderKeyFetch(builderApiKey: string): FetchLike {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set(BUILDER_API_PRIVATE_KEY_HEADER, builderApiKey);
    return fetch(input, { ...init, headers });
  };
}
