import { sign, mnemonicToAccount, type HDAccount } from "viem/accounts";
import { getAddress, serializeSignature, type Address, type Hex } from "viem";

import type {
  ProviderAccount,
  ProviderCredentials,
  SignerProvider,
  SigningIntent,
} from "../vault/providers/signer-provider.interface";

/** A well-known BIP-39 test vector; it holds no value on any network. */
export const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * Accounts, keyed by mnemonic, outliving any one provider instance. A real custody organisation
 * survives container restarts, so a test that reboots the service against the same volume must
 * still find its addresses — and a test that reboots against a *different* mnemonic must not.
 */
const organizations = new Map<string, Map<string, HDAccount>>();

/**
 * Derives the account at `derivationPath` and records the organisation as holding it — what
 * Turnkey does when it creates an account.
 */
function createHeldAccount(mnemonic: string, derivationPath: string): Address {
  const accounts = accountsOf(mnemonic);
  const account =
    accounts.get(derivationPath) ?? mnemonicToAccount(mnemonic, { path: asHdPath(derivationPath) });
  accounts.set(derivationPath, account);
  return getAddress(account.address);
}

function accountsOf(mnemonic: string): Map<string, HDAccount> {
  const existing = organizations.get(mnemonic) ?? new Map<string, HDAccount>();
  organizations.set(mnemonic, existing);
  return existing;
}

/**
 * Stands in for Turnkey by deriving the same BIP-44 tree locally and signing digests with
 * secp256k1 — the identical primitive the TEE applies. That makes the resulting signatures
 * verifiable, so a test can assert what was actually signed rather than that a call was made.
 */
export class FakeSignerProvider implements SignerProvider {
  readonly name = "fake";
  readonly signedIntents: SigningIntent[] = [];

  /** The credentials first init or the boot path handed over, for tests to assert on. */
  adopted: ProviderCredentials | undefined;

  private readonly accounts: Map<string, HDAccount>;

  private readonly mnemonic: string;

  constructor(mnemonic: string = TEST_MNEMONIC) {
    this.mnemonic = mnemonic;
    this.accounts = accountsOf(mnemonic);
  }

  adoptCredentials(credentials: ProviderCredentials): void {
    this.adopted = credentials;
  }

  async createAccount(derivationPath: string, _ref: string): Promise<ProviderAccount> {
    return {
      address: createHeldAccount(this.mnemonic, derivationPath),
      accountId: derivationPath,
    };
  }

  async listAddresses(): Promise<Address[]> {
    return [...this.accounts.values()].map((account) => getAddress(account.address));
  }

  async signRawPayload(address: Address, digest: Hex, intent: SigningIntent): Promise<Hex> {
    this.signedIntents.push(intent);
    const account = this.findByAddress(address);
    if (!account) throw new Error(`fake provider holds no key for ${address}`);
    return serializeSignature(await sign({ hash: digest, privateKey: privateKeyOf(account) }));
  }

  async health(): Promise<{ ready: boolean }> {
    return { ready: true };
  }

  private findByAddress(address: Address): HDAccount | undefined {
    const wanted = address.toLowerCase();
    return [...this.accounts.values()].find((account) => account.address.toLowerCase() === wanted);
  }
}

type HdPath = `m/44'/60'/${string}`;

function asHdPath(derivationPath: string): HdPath {
  return derivationPath as HdPath;
}

/**
 * viem's HD account keeps its key private but exposes it through `getHdKey()`. Reaching for it is
 * acceptable in a test double and nowhere else.
 */
function privateKeyOf(account: HDAccount): Hex {
  const privateKey = account.getHdKey().privateKey;
  if (!privateKey) throw new Error("HD account has no private key");
  return `0x${Buffer.from(privateKey).toString("hex")}`;
}
