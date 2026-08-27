import type { ContractInfo, InternalWalletPort } from "@inabit-com/dpm-sdk/turnkey";

/**
 * What a signing feature needs from the SDK: the deployment's addresses, and a signing port
 * for one of the vault's wallets. The SDK's own `DpmSdk` satisfies this as-is; declaring it
 * here is what lets a test boot the app against a local signer instead of Turnkey.
 */
export type SigningSdk = {
  readonly contractInfo: ContractInfo;
  getWalletPortFor(eoaAddress: string): InternalWalletPort;
};

/**
 * Hands out the one SDK instance the process uses.
 *
 * Building it reaches Turnkey and reads the relayer's contract addresses, so it happens
 * once and the result is reused: a request only asks for a port for its own address, which
 * costs nothing.
 */
export interface SigningSdkSource {
  getSdk(): Promise<SigningSdk>;
}
