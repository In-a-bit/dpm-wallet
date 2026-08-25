import {
  RelayerError,
  ValidationError,
  type SubmitTransactionRequest,
} from "@inabit-com/dpm-sdk/server";
import { Inject, Injectable } from "@nestjs/common";

import type { Config } from "../config";
import type { Wallet } from "../db/repositories/wallet.repo";
import { customerNotRegistered, DpmwError, validationFailed } from "../errors";
import { AuditAction } from "../observability/audit-action";
import { AuditLog } from "../observability/audit";
import { createBuilderKeyFetch } from "../sdk/builder-key-fetch";
import { VaultWalletAdapter } from "../sdk/vault-wallet-adapter";
import {
  buildMetaTx,
  metaTxCommonParams,
  type MetaTxCommonParams,
  type MetaTxKind,
} from "../sdk/wiring";
import { CONFIG, KEY_VAULT } from "../tokens";
import type { KeyVault } from "../vault/key-vault.interface";

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
@Injectable()
export class MetaTxService {
  constructor(
    private readonly audit: AuditLog,
    @Inject(KEY_VAULT) private readonly vault: KeyVault,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async build(
    kind: MetaTxKind,
    wallet: Wallet,
    args: MetaTxArgs,
  ): Promise<SubmitTransactionRequest> {
    assertDpmRegistered(wallet);
    const body = await this.buildThroughSdk(kind, wallet, args);
    await this.audit.record({
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
        this.commonFor(wallet),
      );
    } catch (cause) {
      await this.recordFailure(cause, wallet, kind);
      throw translate(cause, wallet);
    }
  }

  /**
   * The builder credential names the wallet being acted for, so it is assembled per build
   * rather than once: `relayer-api` resolves the caller from the secret and the address
   * together on the reads a build makes.
   */
  private commonFor(wallet: Wallet): MetaTxCommonParams {
    return metaTxCommonParams(
      this.config,
      createBuilderKeyFetch(this.config.relayer.builderApiKey, wallet.eoaAddress),
    );
  }

  private async recordFailure(cause: unknown, wallet: Wallet, kind: MetaTxKind): Promise<void> {
    await this.audit.record({
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
  if (cause instanceof ValidationError) return validationFailed(cause.message, fieldOf(cause));
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

function fieldOf(error: ValidationError): Record<string, unknown> | undefined {
  return error.field === undefined ? undefined : { field: error.field };
}
