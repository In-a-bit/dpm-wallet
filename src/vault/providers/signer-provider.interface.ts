import type { Address, Hex } from "viem";

/**
 * What the payload handed to `signRawPayload` represents. Every variant is already a
 * 32-byte digest — the vault applies the EIP-191 or EIP-712 hashing with viem so the
 * digest is identical whichever provider signs it — but providers differ in how they
 * authorise each kind, so the intent travels with the payload.
 */
export type SigningIntent = "eip191" | "eip712" | "tx";

/**
 * Everything this install acts with: its own Turnkey sub-organisation, the HD wallet inside
 * it, and the P-256 API key pair registered as the sub-org's root user. The key pair
 * authorises requests; it is not a signing key, and it grants nothing outside this sub-org.
 *
 * All four are created together — the sub-org and its wallet by dpm-api, the key pair by
 * this install — so a provider never has to look any of them up.
 */
export type ProviderCredentials = {
  subOrgId: string;
  /**
   * The HD wallet inside the sub-org: the seed every account is derived from. Not an
   * account and not an address.
   */
  walletId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
};

export type ProviderAccount = {
  address: Address;
  /** Provider-side identifier, stored for the cold-start consistency check. */
  accountId: string;
};

/**
 * The custody provider seam. Swapping Turnkey for Fireblocks or Qredo means writing one
 * class and changing one line of wiring; no service, route, or repository code moves.
 */
export interface SignerProvider {
  readonly name: string;

  /**
   * Binds the credentials every later call is made with. First init supplies them as soon
   * as dpm-api answers, and the boot path re-supplies them from the volume, so until it is
   * called the provider can do nothing — which is deliberate: an uninitialised install has
   * no sub-organisation to act on.
   */
  adoptCredentials(credentials: ProviderCredentials): void;

  /** Creates (or returns) the account at `derivationPath`. Idempotent per path. */
  createAccount(derivationPath: string, ref: string): Promise<ProviderAccount>;

  /** Lists the addresses the provider currently holds, for reconciliation at boot. */
  listAddresses(): Promise<Address[]>;

  signRawPayload(address: Address, digest: Hex, intent: SigningIntent): Promise<Hex>;

  health(): Promise<{ ready: boolean }>;
}
