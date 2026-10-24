import {
  RelayerError,
  ValidationError,
  type SubmitTransactionRequest,
} from "@inabit-com/dpm-sdk/turnkey";
import { Inject, Injectable } from "@nestjs/common";

import type { Config } from "../config";
import type { Wallet } from "../db/repositories/wallet.repo";
import { customerNotRegistered, DpmwError, validationFailed } from "../errors";
import { AuditAction } from "../observability/audit-action";
import { AuditLog, type AuditEntry } from "../observability/audit";
import { createBuilderKeyFetch } from "../sdk/builder-key-fetch";
import { translateSigningFailure } from "../sdk/signing-failure";
import type { SigningSdk, SigningSdkSource } from "../sdk/signing-sdk";
import {
  buildMetaTx,
  metaTxCommonParams,
  type MetaTxCommonParams,
  type MetaTxKind,
} from "../sdk/wiring";
import { CONFIG, SIGNING_SDK, TRANSACTION, type Transaction } from "../tokens";

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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Arbitrary constant naming the advisory lock that serialises capped withdrawals. */
const WITHDRAW_CAP_LOCK = 7_302_024;

/**
 * Builds and signs proxy meta-transactions, returning a body the operator POSTs verbatim to
 * `relayer-api`. The signing itself lives in the SDK; this service supplies the wallet, the
 * contract addresses, and the builder credential, and maps failures onto the error envelope.
 */
@Injectable()
export class MetaTxService {
  constructor(
    private readonly audit: AuditLog,
    @Inject(SIGNING_SDK) private readonly sdks: SigningSdkSource,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(TRANSACTION) private readonly transaction: Transaction,
  ) {}

  async build(
    kind: MetaTxKind,
    wallet: Wallet,
    args: MetaTxArgs,
  ): Promise<SubmitTransactionRequest> {
    assertDpmRegistered(wallet);
    await this.assertRecipientAllowed(kind, wallet, args);
    const cap = this.config.withdraw.maxDailyDecimal;
    if (kind === "withdraw" && cap !== undefined && args.amountDecimal !== undefined) {
      return this.buildWithinDailyCap(wallet, args, args.amountDecimal, cap);
    }
    const body = await this.buildThroughSdk(kind, wallet, args);
    await this.audit.record(this.success(kind, wallet, body, args));
    return body;
  }

  /**
   * The check and the success row it counts against sit under one advisory lock, so two
   * concurrent withdrawals cannot both read the same total and both pass. The lock is held
   * across the build (bounded by the outbound deadlines); withdrawals are rare.
   */
  private async buildWithinDailyCap(
    wallet: Wallet,
    args: MetaTxArgs,
    amount: string,
    cap: string,
  ): Promise<SubmitTransactionRequest> {
    const outcome = await this.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [WITHDRAW_CAP_LOCK]);
      const since = new Date(Date.now() - DAY_MS).toISOString();
      const { exceeded, used } = await this.audit.withdrawalWouldExceed(since, amount, cap, tx);
      if (exceeded) {
        await this.audit.record(
          this.refusal("withdraw", wallet, "WITHDRAW_DAILY_LIMIT_EXCEEDED", { amount, used, cap }),
          tx,
        );
        return { refused: true as const };
      }
      const body = await this.buildThroughSdk("withdraw", wallet, args);
      await this.audit.record(this.success("withdraw", wallet, body, args), tx);
      return { refused: false as const, body };
    });
    if (outcome.refused) {
      throw new DpmwError(
        "WITHDRAW_DAILY_LIMIT_EXCEEDED",
        "This withdrawal would exceed the configured rolling 24h limit",
      );
    }
    return outcome.body;
  }

  /** Applies to withdrawals, and to a redeem that pays out to a recipient. */
  private async assertRecipientAllowed(
    kind: MetaTxKind,
    wallet: Wallet,
    args: MetaTxArgs,
  ): Promise<void> {
    const allowed = this.config.withdraw.recipientAllowlist;
    if (allowed.size === 0 || args.recipient === undefined) return;
    if (kind !== "withdraw" && kind !== "redeem") return;
    if (allowed.has(args.recipient.toLowerCase())) return;
    await this.audit.record(
      this.refusal(kind, wallet, "WITHDRAW_RECIPIENT_NOT_ALLOWED", { recipient: args.recipient }),
    );
    throw new DpmwError(
      "WITHDRAW_RECIPIENT_NOT_ALLOWED",
      "The recipient is not on this install's withdrawal allowlist",
    );
  }

  private refusal(
    kind: MetaTxKind,
    wallet: Wallet,
    code: string,
    detail: Record<string, unknown>,
  ): AuditEntry {
    return {
      ref: wallet.ref,
      action: META_TX_AUDIT_ACTION[kind],
      outcome: "failure",
      detail: { code, ...detail },
    };
  }

  private success(
    kind: MetaTxKind,
    wallet: Wallet,
    body: SubmitTransactionRequest,
    args: MetaTxArgs,
  ): AuditEntry {
    return {
      ref: wallet.ref,
      action: META_TX_AUDIT_ACTION[kind],
      outcome: "success",
      detail: {
        from: body.from,
        to: body.to,
        nonce: body.nonce,
        signature: body.signature,
        // What the rolling daily cap sums; recorded for withdrawals only.
        ...(kind === "withdraw"
          ? { amountDecimal: args.amountDecimal, recipient: args.recipient }
          : {}),
      },
    };
  }

  private async buildThroughSdk(
    kind: MetaTxKind,
    wallet: Wallet,
    args: MetaTxArgs,
  ): Promise<SubmitTransactionRequest> {
    try {
      // Inside the try: an uninitialised vault or an unreachable relayer is a failed build
      // like any other, and belongs in the audit trail under the kind that was attempted.
      const sdk = await this.sdks.getSdk();
      return await buildMetaTx(
        kind,
        {
          wallet: sdk.getWalletPortFor(wallet.eoaAddress),
          proxyWallet: wallet.proxyAddress,
          ...args,
        },
        this.commonFor(sdk, wallet),
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
  private commonFor(sdk: SigningSdk, wallet: Wallet): MetaTxCommonParams {
    return metaTxCommonParams(
      sdk.contractInfo,
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
  const signingFailure = translateSigningFailure(cause);
  if (signingFailure) return signingFailure;
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
