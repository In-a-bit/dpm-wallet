import {
  buildFundWithdrawTx,
  buildMergePositionsTx,
  buildRedeemPositionsTx,
  buildSplitPositionTx,
  buildUsdcCtfAllowanceTx,
  type ContractInfo,
  type FetchLike,
  type InternalWalletPort,
  type SubmitTransactionRequest,
} from "@inabit-com/dpm-sdk/turnkey";

import type { Config } from "../config";

/**
 * The five meta-transaction kinds the service can sign. Both the route table and the
 * builder lookup key off these, so adding a kind is a single-place change.
 */
export const META_TX_KINDS = ["allowance", "redeem", "withdraw", "split", "merge"] as const;
export type MetaTxKind = (typeof META_TX_KINDS)[number];

export type MetaTxBuildRequest = {
  wallet: InternalWalletPort;
  proxyWallet: string;
  conditionId?: string;
  amountDecimal?: string;
  recipient?: string;
};

/**
 * Dispatches to the SDK's build-only meta-transaction functions, which sign and return the
 * request body without submitting it. Submission is the operator's step.
 *
 * The per-kind argument requirements are enforced by the route DTOs, so a missing
 * `conditionId` here is a wiring bug rather than a client error — hence the plain throw.
 */
export function buildMetaTx(
  kind: MetaTxKind,
  request: MetaTxBuildRequest,
  common: MetaTxCommonParams,
): Promise<SubmitTransactionRequest> {
  const base = { ...common, wallet: request.wallet, proxyWallet: request.proxyWallet };
  switch (kind) {
    case "allowance":
      return buildUsdcCtfAllowanceTx(base);
    case "redeem":
      return buildRedeemPositionsTx({
        ...base,
        conditionId: requiredField(request.conditionId, "conditionId"),
        // Optional here, unlike withdraw: an absent recipient is a redeem-only transaction.
        recipient: request.recipient,
      });
    case "split":
      return buildSplitPositionTx({
        ...base,
        conditionId: requiredField(request.conditionId, "conditionId"),
        amountDecimal: requiredField(request.amountDecimal, "amountDecimal"),
      });
    case "merge":
      return buildMergePositionsTx({
        ...base,
        conditionId: requiredField(request.conditionId, "conditionId"),
        amountDecimal: requiredField(request.amountDecimal, "amountDecimal"),
      });
    case "withdraw":
      return buildFundWithdrawTx({
        ...base,
        recipient: requiredField(request.recipient, "recipient"),
        amountDecimal: requiredField(request.amountDecimal, "amountDecimal"),
      });
  }
}

export type MetaTxCommonParams = {
  relayerBaseUrl: string;
  contractInfo: ContractInfo;
  fetchImpl: FetchLike;
};

export function metaTxCommonParams(
  contractInfo: ContractInfo,
  config: Config,
  fetchImpl: FetchLike,
): MetaTxCommonParams {
  return {
    relayerBaseUrl: config.relayer.baseUrl,
    contractInfo,
    fetchImpl,
  };
}

function requiredField<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`meta-tx build is missing "${field}"`);
  return value;
}
