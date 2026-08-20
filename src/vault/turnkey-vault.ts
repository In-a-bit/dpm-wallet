import {
  hashMessage,
  hashTypedData,
  keccak256,
  parseSignature,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializable,
  type TypedDataDefinition,
} from "viem";

import type { VaultMode } from "../config.js";
import {
  derivationPath,
  type KeyVault,
  type MasterInfo,
  type VaultAccount,
  type VaultHealth,
} from "./key-vault.interface.js";
import type { SigningIntent, SignerProvider } from "./providers/signer-provider.interface.js";

export type TurnkeyVaultState = {
  /** This install's own Turnkey sub-organisation. */
  subOrgId: string;
  /** The HD wallet inside that sub-org, which every account is derived from. */
  walletId: string;
  master: MasterInfo;
};

/**
 * The only vault in phase 1. It owns no key material: every signature is a request to the
 * `SignerProvider`, and this class's job is to produce the right digest for it.
 */
export class TurnkeyKeyVault implements KeyVault {
  readonly mode: VaultMode = "turnkey";

  private state: TurnkeyVaultState | undefined;

  constructor(private readonly provider: SignerProvider) {}

  /**
   * Takes on the sub-organisation, its HD wallet and its master account — all three created
   * before this class ever sees them, by dpm-api on first init and by the volume on every
   * boot after. Nothing is created here, which is why it is safe to call on every start.
   */
  adopt(state: TurnkeyVaultState): void {
    this.state = state;
  }

  get initializedState(): TurnkeyVaultState | undefined {
    return this.state;
  }

  async createAccount(index: number, ref: string): Promise<VaultAccount> {
    const account = await this.provider.createAccount(derivationPath(index), ref);
    return { address: account.address, index, ref, accountId: account.accountId };
  }

  // Declared async so a provider failure arrives as a rejection like every other failure,
  // rather than forcing callers to guard the call with both a try/catch and a .catch.
  async signTypedData(address: Address, typedData: TypedDataDefinition): Promise<Hex> {
    return this.signDigest(address, hashTypedData(typedData), "eip712");
  }

  /**
   * Reproduces the SDK's EOA branch exactly: a 0x-prefixed hex string is signed as raw
   * bytes, anything else as UTF-8. The `rlx:` struct hash is hex and a cancel message is
   * plaintext; hashing either the other way computes the signature over the wrong
   * preimage, and the RelayHub or the exchange rejects it with no indication of why.
   */
  async personalSign(address: Address, message: Hex | string): Promise<Hex> {
    const digest = isHexString(message) ? hashMessage({ raw: message }) : hashMessage(message);
    return this.signDigest(address, digest, "eip191");
  }

  /**
   * Signs the transaction's serialisation digest and re-serialises it with the signature,
   * so a provider only ever needs the one raw-payload primitive.
   */
  async signTransaction(address: Address, tx: TransactionSerializable): Promise<Hex> {
    const digest = keccak256(serializeTransaction(tx));
    const signature = await this.signDigest(address, digest, "tx");
    return serializeTransaction(tx, parseSignature(signature));
  }

  listAddresses(): Promise<Address[]> {
    return this.provider.listAddresses();
  }

  async health(): Promise<VaultHealth> {
    const { ready } = await this.provider.health();
    return { mode: this.mode, initialized: this.state !== undefined, ready };
  }

  private signDigest(address: Address, digest: Hex, intent: SigningIntent): Promise<Hex> {
    return this.provider.signRawPayload(address, digest, intent);
  }
}

/** Matches the SDK's test for "this message is already bytes, do not treat it as text". */
function isHexString(message: Hex | string): message is Hex {
  return message.startsWith("0x") && /^0x[0-9a-fA-F]+$/.test(message);
}
