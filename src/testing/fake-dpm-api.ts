import type {
  CreateSubOrganizationRequest,
  SubOrganization,
  SubOrganizationCreator,
} from "../clients/dpm-api.client";

/**
 * Stands in for dpm-api's sub-organisation endpoint, including the thing that matters most to
 * the install: it is keyed on the public key it receives, so a retry with the same key pair
 * gets the same sub-organisation back rather than a second one.
 *
 * It derives no account, exactly as the real Turnkey activity does not — the sub-org arrives
 * holding an empty HD wallet, and every address is minted later by the signer provider.
 */
export class FakeDpmApi implements SubOrganizationCreator {
  readonly requests: CreateSubOrganizationRequest[] = [];

  /** Set to make the next call fail, standing in for dpm-api being down. */
  failWith: Error | undefined;

  private readonly subOrgsByPublicKey = new Map<string, SubOrganization>();

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
    };
    this.subOrgsByPublicKey.set(request.apiPublicKey, created);
    return created;
  }

  /** How many distinct sub-organisations were created, i.e. how many key pairs were used. */
  get createdCount(): number {
    return this.subOrgsByPublicKey.size;
  }
}
