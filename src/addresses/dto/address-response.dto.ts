import type { Wallet } from "../../db/repositories/wallet.repo";

export class AddressResponseDto {
  ref!: string;
  index!: number;
  address!: string;
  proxyAddress!: string;
  dpmRegistered!: boolean;
  createdAt!: string;
}

export function toAddressResponse(wallet: Wallet): AddressResponseDto {
  return {
    ref: wallet.ref,
    index: wallet.derivationIndex,
    address: wallet.eoaAddress,
    proxyAddress: wallet.proxyAddress,
    dpmRegistered: wallet.dpmRegistered,
    createdAt: wallet.createdAt,
  };
}
