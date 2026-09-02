import type { Address } from "viem";

import type {
  CustodyRegistration,
  CustodyUser,
  CustodyUserRegistrar,
} from "../clients/gamma-api.client";
import { deriveProxyAddress } from "../crypto/proxy-address";
import { TEST_CONTRACTS } from "./env";

/**
 * Stands in for gamma-api's custody onboarding. It derives the proxy the way the real handler
 * does — from the factory and implementation addresses — so the check that the two services
 * agree is exercised rather than trivially satisfied, and it is idempotent per address, which
 * is what makes a provisioning retry safe upstream.
 */
export class FakeGammaApi implements CustodyUserRegistrar {
  /** Every onboarding this stub received, in order. */
  readonly custodyRequests: CustodyRegistration[] = [];

  /** Set to make onboarding fail, standing in for a platform that is down or refuses. */
  failWith: Error | undefined;

  /**
   * Overrides the proxy the platform reports back, which is how a test stands up the case
   * where the two services are pointed at different proxy factories.
   */
  proxyWalletOverride: Address | undefined;

  async registerCustodyUser(registration: CustodyRegistration): Promise<CustodyUser> {
    this.custodyRequests.push(registration);
    if (this.failWith) throw this.failWith;

    return {
      address: registration.address,
      proxyWallet:
        this.proxyWalletOverride ?? deriveProxyAddress(registration.address, TEST_CONTRACTS),
    };
  }
}
