import type { ContractInfo, InternalWalletPort } from "@inabit-com/dpm-sdk/turnkey";
import { getAddress, type TypedDataDefinition } from "viem";

import type { Config } from "../config";
import type { SigningSdk, SigningSdkSource } from "../sdk/signing-sdk";
import type { KeyVault } from "../vault/key-vault.interface";

/**
 * The addresses the real SDK reads from the relayer's `GET /contract-info`. Fixed here so a
 * test boots without that call, the way it boots without Turnkey.
 */
const RELAYER_ADDRESSES = {
  collateral: getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),
  ctf: getAddress("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"),
  relayHub: getAddress("0xD216153c06e857Cd7F72665e0aF1D7d82172f495"),
} as const;

/**
 * Stands in for the SDK's Turnkey-backed instance by signing through the vault, which in a
 * test is the local signer. The digests are the ones the SDK's own port computes — EIP-712
 * typed data and the EIP-191 raw/UTF-8 split — so a test still asserts on real signatures
 * recovered from the address that signed them.
 */
export class FakeSigningSdk implements SigningSdk, SigningSdkSource {
  readonly contractInfo: ContractInfo;

  constructor(
    private readonly vault: KeyVault,
    config: Config,
  ) {
    this.contractInfo = {
      chainId: String(config.chainId),
      ctfExchange: config.contracts.ctfExchange,
      proxyFactory: config.contracts.proxyFactory,
      ...RELAYER_ADDRESSES,
    };
  }

  async getSdk(): Promise<SigningSdk> {
    return this;
  }

  getWalletPortFor(eoaAddress: string): InternalWalletPort {
    const address = getAddress(eoaAddress);
    const vault = this.vault;
    return {
      getEoaAddress: async () => address,
      signTypedDataV4: (_address: string, typedDataJson: string) =>
        vault.signTypedData(address, JSON.parse(typedDataJson) as TypedDataDefinition),
      personalSign: (message: string, _address: string) => vault.personalSign(address, message),
    };
  }
}
