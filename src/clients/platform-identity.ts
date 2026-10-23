import { BUILDER_ADDRESS_HEADER, BUILDER_API_PRIVATE_KEY_HEADER } from "../sdk/builder-key-fetch";

/** The header a liquidity-provider install authenticates with instead of a builder secret. */
export const LP_API_KEY_HEADER = "X-LP-Api-Key";

/** Names the address an LP install is acting for, the counterpart of `X-Builder-Address`. */
export const LP_ADDRESS_HEADER = "X-LP-Address";

/**
 * Which owner this install belongs to is decided entirely by which credential it holds: an LP
 * key when one is configured, otherwise the builder secret it already uses for the relayer.
 * The address header is added only for calls that act for one wallet; the secret alone reaches
 * the reads that are scoped to the owner rather than to an address.
 */
export function platformIdentityHeaders(
  config: { builderApiKey: string; lpApiKey?: string },
  actingAddress?: string,
): Record<string, string> {
  if (config.lpApiKey) {
    return {
      [LP_API_KEY_HEADER]: config.lpApiKey,
      ...(actingAddress ? { [LP_ADDRESS_HEADER]: actingAddress } : {}),
    };
  }
  return {
    [BUILDER_API_PRIVATE_KEY_HEADER]: config.builderApiKey,
    ...(actingAddress ? { [BUILDER_ADDRESS_HEADER]: actingAddress } : {}),
  };
}
