import type { InternalWalletPort } from "@inabit-com/dpm-sdk/server";
import type { Address } from "viem";

import type { KeyVault } from "../vault/key-vault.interface.js";

/**
 * Bridges the SDK's single-wallet signing port onto the multi-wallet vault by binding one
 * address per request.
 *
 * The SDK's two signing methods take the address on opposite sides — `signTypedDataV4`
 * first, `personalSign` second — so the parameter names here are deliberately explicit.
 */
export class VaultWalletAdapter implements InternalWalletPort {
  constructor(
    private readonly vault: KeyVault,
    private readonly address: Address,
  ) {}

  async getEoaAddress(): Promise<string> {
    return this.address;
  }

  signTypedDataV4 = (address: string, typedDataJson: string): Promise<string> =>
    this.vault.signTypedData(address as Address, JSON.parse(typedDataJson));

  personalSign = (message: string, address: string): Promise<string> =>
    this.vault.personalSign(address as Address, message);
}
