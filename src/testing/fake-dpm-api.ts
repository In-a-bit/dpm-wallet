import type {
  CreateSubOrganizationRequest,
  SubOrganization,
  SubOrganizationCreator,
} from "../clients/dpm-api.client.js";
import { createHeldAccount, TEST_MNEMONIC } from "./fake-signer-provider.js";

/**
 * Stands in for dpm-api's sub-organisation endpoint, including the two things that matter
 * most to the install: it is keyed on the public key it receives, so a retry with the same
 * key pair gets the same sub-organisation back rather than a second one, and it creates the
 * master account as part of that call, exactly as the real Turnkey activity does.
 *
 * The master is derived from the same mnemonic the fake provider signs with, so the address
 * this returns is one the install can then actually produce signatures for.
 */
export class FakeDpmApi implements SubOrganizationCreator {
  readonly requests: CreateSubOrganizationRequest[] = [];

  /** Set to make the next call fail, standing in for dpm-api being down. */
  failWith: Error | undefined;

  private readonly subOrgsByPublicKey = new Map<string, SubOrganization>();

  constructor(private readonly mnemonic: string = TEST_MNEMONIC) {}

  async createSubOrganization(request: CreateSubOrganizationRequest): Promise<SubOrganization> {
    this.requests.push(request);
    if (this.failWith) throw this.failWith;

    const existing = this.subOrgsByPublicKey.get(request.apiPublicKey);
    if (existing) return existing;

    const ordinal = this.subOrgsByPublicKey.size + 1;
    const created: SubOrganization = {
      subOrgId: `fake-sub-org-${ordinal}`,
      subOrgName: `dpm-builder-1-fake-${ordinal}`,
      walletId: `fake-wallet-${ordinal}`,
      masterAddress: createHeldAccount(this.mnemonic, request.masterDerivationPath),
    };
    this.subOrgsByPublicKey.set(request.apiPublicKey, created);
    return created;
  }

  /** How many distinct sub-organisations were created, i.e. how many key pairs were used. */
  get createdCount(): number {
    return this.subOrgsByPublicKey.size;
  }
}
