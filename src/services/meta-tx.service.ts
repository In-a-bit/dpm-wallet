import {
  RelayerError,
  type SubmitTransactionRequest,
} from "@inabit-com/dpm-sdk/server";

import type { Config } from "../config.js";
import type { Wallet } from "../db/repositories/wallet.repo.js";
import { DpmwError, customerNotRegistered } from "../errors.js";
import { AuditAction } from "../observability/audit-action.js";
import { AuditLog } from "../observability/audit.js";
import { createBuilderKeyFetch } from "../sdk/builder-key-fetch.js";
import { VaultWalletAdapter } from "../sdk/vault-wallet-adapter.js";
import {
  buildMetaTx,
  metaTxCommonParams,
  type MetaTxCommonParams,
  type MetaTxKind,
} from "../sdk/wiring.js";
import type { KeyVault } from "../vault/key-vault.interface.js";

export type MetaTxArgs = {
  conditionId?: string;
  amountDecimal?: string;
  recipient?: string;
};

/**
 * `relayer-api` resolves the RelayHub nonce from the DPM `users` table and reports a
 * missing user as a 500. Recognising that body is what lets an unregistered EOA surface as
 * CUSTOMER_NOT_REGISTERED rather than a generic upstream failure.
 */
const UNREGISTERED_EOA_MARKER = "user not found";

/**
 * Builds and signs proxy meta-transactions, returning a body the operator POSTs verbatim to
 * `relayer-api`. The signing itself lives in the SDK; this service supplies the wallet, the
 * contract addresses, and the builder credential, and maps failures onto the error envelope.
 */
export class MetaTxService {
  private readonly common: MetaTxCommonParams;

  constructor(
    private readonly vault: KeyVault,
    config: Config,
    private readonly audit: AuditLog,
  ) {
    this.common = metaTxCommonParams(config, createBuilderKeyFetch(config.relayer.builderApiKey));
  }

  async build(
    kind: MetaTxKind,
    wallet: Wallet,
    args: MetaTxArgs,
  ): Promise<SubmitTransactionRequest> {
    assertDpmRegistered(wallet);
    const body = await this.buildThroughSdk(kind, wallet, args);
    this.audit.record({
      ref: wallet.ref,
      action: META_TX_AUDIT_ACTION[kind],
      outcome: "success",
      detail: { from: body.from, to: body.to, nonce: body.nonce, signature: body.signature },
    });
    return body;
  }

  private async buildThroughSdk(
    kind: MetaTxKind,
    wallet: Wallet,
    args: MetaTxArgs,
  ): Promise<SubmitTransactionRequest> {
    try {
      return await buildMetaTx(
        kind,
        {
          wallet: new VaultWalletAdapter(this.vault, wallet.eoaAddress),
          proxyWallet: wallet.proxyAddress,
          ...args,
        },
        this.common,
      );
    } catch (cause) {
      this.recordFailure(cause, wallet, kind);
      throw translate(cause, wallet);
    }
  }

  private recordFailure(cause: unknown, wallet: Wallet, kind: MetaTxKind): void {
    this.audit.record({
      ref: wallet.ref,
      action: META_TX_AUDIT_ACTION[kind],
      outcome: "failure",
      detail: { message: cause instanceof Error ? cause.message : String(cause) },
    });
  }
}

const META_TX_AUDIT_ACTION: Record<MetaTxKind, AuditAction> = {
  allowance: AuditAction.MetaAllowance,
  redeem: AuditAction.MetaRedeem,
  split: AuditAction.MetaSplit,
  merge: AuditAction.MetaMerge,
  withdraw: AuditAction.MetaWithdraw,
};

/**
 * Maps an SDK failure onto the error envelope. Anything already carrying a code passes
 * through untouched, and an upstream failure stays generic: all this service knows is that
 * the call did not succeed, not whether `relayer-api` was down, refused the credential, or
 * rejected the request.
 */
function translate(cause: unknown, wallet: Wallet): unknown {
  if (cause instanceof DpmwError) return cause;
  if (!(cause instanceof RelayerError)) return cause;
  if (mentionsUnregisteredEoa(cause)) return customerNotRegistered(wallet.ref);
  return new DpmwError("RELAYER_REQUEST_FAILED", `relay-payload failed: ${cause.message}`, {
    cause,
  });
}

/**
 * The precondition is checked locally first so the operator gets a definitive answer
 * without a round-trip, and so "not yet registered with DPM" stays distinguishable from
 * a genuine signing failure.
 */
function assertDpmRegistered(wallet: Wallet): void {
  if (!wallet.dpmRegistered) throw customerNotRegistered(wallet.ref);
}

function mentionsUnregisteredEoa(error: RelayerError): boolean {
  return error.message.toLowerCase().includes(UNREGISTERED_EOA_MARKER);
}
