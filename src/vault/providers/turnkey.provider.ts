import { Turnkey, type TurnkeyApiClient } from "@turnkey/sdk-server";
import { getAddress, type Address, type Hex } from "viem";

import type { Config } from "../../config";
import { DpmwError } from "../../errors";
import { logDebug } from "../../observability/log";
import type {
  ProviderAccount,
  ProviderCredentials,
  SignerProvider,
  SigningIntent,
} from "./signer-provider.interface";

const ETHEREUM_ACCOUNT = {
  curve: "CURVE_SECP256K1",
  pathFormat: "PATH_FORMAT_BIP32",
  addressFormat: "ADDRESS_FORMAT_ETHEREUM",
} as const;

/**
 * The digest is already hashed by the vault, so Turnkey must sign the bytes verbatim.
 * Letting it hash again would sign keccak256(digest) and produce a signature that
 * recovers to nobody.
 */
const RAW_DIGEST_SIGNING = {
  encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
  hashFunction: "HASH_FUNCTION_NO_OP",
} as const;

/**
 * Key custody in the Turnkey TEE, scoped to this install's own sub-organisation.
 *
 * The credentials arrive after construction, not from the environment: the key pair is
 * minted on the volume and the sub-organisation is created for it on first init, which is
 * what stops an operator install from ever holding a credential that reaches another
 * install's keys. No private key that signs anything on-chain reaches this process either —
 * the API key pair only authorises requests.
 */
export class TurnkeySignerProvider implements SignerProvider {
  readonly name = "turnkey";

  private readonly apiBaseUrl: string;
  private session: TurnkeySession | undefined;

  constructor(config: Pick<Config["turnkey"], "apiBaseUrl">) {
    this.apiBaseUrl = config.apiBaseUrl;
  }

  adoptCredentials(credentials: ProviderCredentials): void {
    const client = new Turnkey({
      apiBaseUrl: this.apiBaseUrl,
      // The SDK's constructor keys are fixed and say "organization"; for this client the
      // organisation it defaults to is always the install's own sub-org.
      defaultOrganizationId: credentials.subOrgId,
      apiPublicKey: credentials.apiPublicKey,
      apiPrivateKey: credentials.apiPrivateKey,
    }).apiClient();
    this.session = {
      subOrgId: credentials.subOrgId,
      walletId: credentials.walletId,
      client,
    };
    logDebug("turnkey.credentials_adopted", {
      subOrgId: credentials.subOrgId,
      walletId: credentials.walletId,
    });
  }

  async createAccount(derivationPath: string, ref: string): Promise<ProviderAccount> {
    const { walletId } = this.requireSession();
    const existing = await this.findAccountByPath(walletId, derivationPath);
    if (existing) return existing;

    const created = await this.call("createWalletAccounts", (client) =>
      client.createWalletAccounts({
        organizationId: this.subOrgId(),
        walletId,
        accounts: [{ ...ETHEREUM_ACCOUNT, path: derivationPath }],
      }),
    );
    const address = created.addresses[0];
    if (!address) {
      throw new DpmwError("SIGNING_FAILED", `Turnkey returned no address for ${ref}`);
    }
    // Turnkey exposes the account id only through a lookup, so re-read it rather than
    // leaving the directory without the identifier the boot-time check compares against.
    const account = await this.findAccountByPath(walletId, derivationPath);
    return account ?? { address: getAddress(address), accountId: derivationPath };
  }

  async listAddresses(): Promise<Address[]> {
    const { walletId } = this.requireSession();
    const accounts = await this.fetchAccounts(walletId);
    return accounts.map((account) => getAddress(account.address));
  }

  async signRawPayload(address: Address, digest: Hex, intent: SigningIntent): Promise<Hex> {
    const result = await this.call("signRawPayload", (client) =>
      client.signRawPayload({
        organizationId: this.subOrgId(),
        signWith: address,
        payload: digest,
        ...RAW_DIGEST_SIGNING,
      }),
    );
    logDebug("turnkey.signed", { address, intent });
    return assembleSignature(result);
  }

  async health(): Promise<{ ready: boolean }> {
    if (!this.session) return { ready: false };
    try {
      await this.session.client.getWhoami({ organizationId: this.session.subOrgId });
      return { ready: true };
    } catch {
      return { ready: false };
    }
  }

  private async findAccountByPath(
    walletId: string,
    derivationPath: string,
  ): Promise<ProviderAccount | undefined> {
    const accounts = await this.fetchAccounts(walletId);
    const match = accounts.find((account) => account.path === derivationPath);
    if (!match) return undefined;
    return { address: getAddress(match.address), accountId: match.walletAccountId };
  }

  private async fetchAccounts(walletId: string) {
    const { accounts } = await this.call("getWalletAccounts", (client) =>
      client.getWalletAccounts({ organizationId: this.subOrgId(), walletId }),
    );
    return accounts;
  }

  /**
   * Turnkey failures arrive as opaque HTTP errors. Wrapping them keeps the credentials out
   * of the message while naming the activity that failed, which is what a support ticket
   * needs from a log line.
   */
  private async call<T>(
    activity: string,
    run: (client: TurnkeyApiClient) => Promise<T>,
  ): Promise<T> {
    const { client } = this.requireSession();
    try {
      return await run(client);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new DpmwError("SIGNING_FAILED", `Turnkey ${activity} failed: ${detail}`, { cause });
    }
  }

  private subOrgId(): string {
    return this.requireSession().subOrgId;
  }

  /**
   * The single guard every Turnkey call passes, so an install that has no sub-organisation
   * yet says exactly that instead of failing deeper with a credentials error that reads
   * like an outage.
   */
  private requireSession(): TurnkeySession {
    if (!this.session) {
      throw new DpmwError(
        "VAULT_NOT_INITIALIZED",
        "No Turnkey sub-organization credentials; call POST /v1/vault/init first",
      );
    }
    return this.session;
  }
}

/**
 * The client and what it acts on, bound together so no call can be made against a sub-org
 * or wallet the credentials do not belong to.
 */
type TurnkeySession = {
  subOrgId: string;
  walletId: string;
  client: TurnkeyApiClient;
};

/**
 * Turnkey returns the ECDSA components separately, with `v` as a 0/1 recovery id. viem's
 * verification and transaction serialisation expect a 65-byte r‖s‖v with v in {27, 28}.
 */
function assembleSignature(signature: { r: string; s: string; v: string }): Hex {
  const r = signature.r.replace(/^0x/, "").padStart(64, "0");
  const s = signature.s.replace(/^0x/, "").padStart(64, "0");
  const recoveryId = Number.parseInt(signature.v.replace(/^0x/, ""), 16);
  if (recoveryId !== 0 && recoveryId !== 1) {
    throw new DpmwError("SIGNING_FAILED", `Turnkey returned an unexpected v: ${signature.v}`);
  }
  const v = (27 + recoveryId).toString(16).padStart(2, "0");
  return `0x${r}${s}${v}`;
}
