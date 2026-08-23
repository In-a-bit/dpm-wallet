import { Injectable } from "@nestjs/common";
import type { Address } from "viem";

import { WalletRepository, type Wallet } from "../db/repositories/wallet.repo";
import { policyViolation } from "../errors";

/**
 * The treasury rules, and none of them is a balance check.
 *
 * They follow from where money is allowed to sit. A user's tradable balance lives in their
 * proxy wallet, which only the RelayHub can move; their EOA is a signing key and holds
 * nothing by design. The master's balance sits in its own EOA, which is why the master is
 * the only wallet that can pay an address this service does not manage.
 *
 * Three movements are therefore legitimate, and the endpoints are shaped so that no other
 * one can be expressed: the master funds a user's proxy, the master pays out externally,
 * and a user's EOA is swept back to the master. The proxy-to-master direction is a relayed
 * transaction rather than a raw one, so it lives at `POST /v1/meta-tx/withdraw`.
 *
 * Nothing else is policed. Whether any address holds what is being signed for depends on
 * ledger state this service cannot see.
 */
@Injectable()
export class TreasuryPolicy {
  constructor(private readonly wallets: WalletRepository) {}

  /**
   * Only a user's proxy can be funded. The master's own proxy is not a destination: the
   * master trades nothing, and its balance is already in the EOA the funding is drawn from.
   */
  assertProxyFundingAllowed(target: Wallet): void {
    if (target.role === "user") return;
    throw policyViolation(
      "Only a user's proxy can be funded; the master's balance already sits in its own EOA",
      { ref: target.ref, role: target.role },
    );
  }

  /**
   * A sweep recovers assets someone sent to a signing key by mistake, so it runs from a user
   * EOA towards the master and never the other way. The master is the destination here, and
   * paying out from it is what the external withdrawal endpoint is for.
   */
  assertSweepAllowed(source: Wallet): void {
    if (source.role === "user") return;
    throw policyViolation(
      "A sweep recovers stray assets from a user's EOA; use /v1/treasury/external-withdraw to pay out of the master",
      { ref: source.ref, role: source.role },
    );
  }

  /**
   * An external withdrawal must leave the perimeter. Allowing it to land on an address this
   * service manages would reintroduce the two movements the shape above rules out — funding
   * a proxy without the accounting, or crediting a signing key that should never hold value.
   */
  assertDestinationIsExternal(destination: Address): void {
    const proxyOwner = this.wallets.findByProxy(destination);
    if (proxyOwner) {
      throw policyViolation(
        "That address is a managed proxy; use /v1/treasury/fund-proxy to credit a user",
        { destination, ref: proxyOwner.ref },
      );
    }
    const eoaOwner = this.wallets.findByEoa(destination);
    if (eoaOwner) {
      throw policyViolation(
        "That address is a managed EOA; those are signing keys and are never funded",
        { destination, ref: eoaOwner.ref },
      );
    }
  }
}
