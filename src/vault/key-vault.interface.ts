import type { Address, Hex, TypedDataDefinition } from "viem";

import type { VaultMode } from "../config";

export type VaultAccount = {
  address: Address;
  index: number;
  /** Operator-supplied opaque reference, e.g. a customer id. */
  ref: string;
  /** Provider-side account identifier, when the provider exposes one. */
  accountId: string | null;
};

export type VaultHealth = {
  mode: VaultMode;
  initialized: boolean;
  /** Reachability of the custody backend. */
  ready: boolean;
};

/**
 * The single seam every custody mode implements. No service code above it knows where a
 * key lives, which is what lets a mnemonic vault or a different provider drop in later.
 *
 * Every signing method takes the address to sign with and uses it to select the right key
 * out of many — that is what lets one process drive thousands of wallets.
 */
export interface KeyVault {
  readonly mode: VaultMode;

  /** Derives or creates the account at `index`, tagging it with `ref`. Idempotent per index. */
  createAccount(index: number, ref: string): Promise<VaultAccount>;

  /** EIP-712 typed-data signature, for orders. */
  signTypedData(address: Address, typedData: TypedDataDefinition): Promise<Hex>;

  /** EIP-191 personal_sign, for meta-tx struct hashes and cancel messages. */
  personalSign(address: Address, message: Hex | string): Promise<Hex>;

  /** The addresses the custody backend currently holds, for the boot-time reconciliation. */
  listAddresses(): Promise<Address[]>;

  health(): Promise<VaultHealth>;
}

/** The BIP-44 Ethereum account path for a derivation index; see §6.3 of the spec. */
export function derivationPath(index: number): string {
  return `m/44'/60'/0'/0/${index}`;
}
