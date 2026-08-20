import {
  encodeFunctionData,
  parseUnits,
  type Address,
  type Hex,
  type TransactionSerializable,
} from "viem";

import type { Config } from "../config.js";
import type { Wallet, WalletRepository } from "../db/repositories/wallet.repo.js";
import { vaultNotInitialized } from "../errors.js";
import { AuditAction } from "../observability/audit-action.js";
import { AuditLog } from "../observability/audit.js";
import type { KeyVault } from "../vault/key-vault.interface.js";
import type { TreasuryPolicy } from "./policy.js";

const COLLATERAL_DECIMALS = 6;
const NATIVE_DECIMALS = 18;

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export type TreasuryAsset = "usdc" | "native";

/**
 * Chain parameters the caller must supply. There is no RPC provider in this service — that
 * is what makes balance-agnosticism structural rather than a convention — so the nonce and
 * the fee ceilings can only come from the operator, who does have a node.
 */
export type ChainParams = {
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

/** What every treasury call carries; the asset and the two ends vary by movement. */
export type TreasuryAmount = {
  amountDecimal: string;
  chain: ChainParams;
};

export type AssetTransfer = TreasuryAmount & { asset: TreasuryAsset };

export type TransferRequest = AssetTransfer & { destination: Address };

export type SignedTransaction = {
  from: Address;
  to: Address;
  signedTransaction: Hex;
};

/**
 * Signs raw EVM treasury transactions and returns the signed hex; broadcasting is the
 * operator's step. The amount is signed as given — this service never checks that `from`
 * holds it.
 */
export class TreasuryService {
  constructor(
    private readonly vault: KeyVault,
    private readonly config: Config,
    private readonly wallets: WalletRepository,
    private readonly policy: TreasuryPolicy,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Master EOA to a user's proxy, where a tradable balance has to sit. USDC only: the proxy
   * is an EIP-1167 clone with no payable fallback, so it cannot receive the native token.
   */
  fundProxy(target: Wallet, amount: TreasuryAmount): Promise<SignedTransaction> {
    this.policy.assertProxyFundingAllowed(target);
    return this.signTransfer(
      this.master(),
      { ...amount, asset: "usdc" as const, destination: target.proxyAddress },
      AuditAction.TreasuryFundProxy,
      target.ref,
    );
  }

  /** Master EOA to an address this service does not manage. */
  externalWithdraw(request: TransferRequest): Promise<SignedTransaction> {
    this.policy.assertDestinationIsExternal(request.destination);
    const master = this.master();
    return this.signTransfer(
      master,
      request,
      AuditAction.TreasuryExternalWithdraw,
      master.ref,
    );
  }

  /**
   * A user's EOA back to the master. Managed EOAs are signing keys and are never funded on
   * purpose, so this exists only to recover assets someone sent to one by mistake.
   */
  sweepToMaster(source: Wallet, request: AssetTransfer): Promise<SignedTransaction> {
    this.policy.assertSweepAllowed(source);
    return this.signTransfer(
      source,
      { ...request, destination: this.master().eoaAddress },
      AuditAction.TreasurySweep,
      source.ref,
    );
  }

  /** The master is a singleton, so callers name the other end and never this one. */
  private master(): Wallet {
    const master = this.wallets.findByRole("master");
    if (!master) throw vaultNotInitialized();
    return master;
  }

  /**
   * `subjectRef` is the wallet the movement is *about*, which is not always the one that
   * signs it: funding a proxy is signed by the master but belongs to the user's trail, so
   * `GET /v1/audit?ref=<user>` shows the credit that reached them.
   */
  private async signTransfer(
    source: Wallet,
    request: TransferRequest,
    action: AuditAction,
    subjectRef: string,
  ): Promise<SignedTransaction> {
    const tx = this.buildTransaction(request);
    const signedTransaction = await this.vault.signTransaction(source.eoaAddress, tx);
    this.audit.record({
      ref: subjectRef,
      action,
      outcome: "success",
      detail: {
        asset: request.asset,
        source: source.eoaAddress,
        destination: request.destination,
        amountDecimal: request.amountDecimal,
        nonce: request.chain.nonce,
        signedTransaction,
      },
    });
    return { from: source.eoaAddress, to: tx.to as Address, signedTransaction };
  }

  private buildTransaction(request: TransferRequest): TransactionSerializable {
    const fee = {
      chainId: this.config.chainId,
      type: "eip1559" as const,
      nonce: request.chain.nonce,
      gas: request.chain.gasLimit,
      maxFeePerGas: request.chain.maxFeePerGas,
      maxPriorityFeePerGas: request.chain.maxPriorityFeePerGas,
    };
    if (request.asset === "native") {
      return {
        ...fee,
        to: request.destination,
        value: parseUnits(request.amountDecimal, NATIVE_DECIMALS),
      };
    }
    return {
      ...fee,
      to: this.config.contracts.collateral,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [request.destination, parseUnits(request.amountDecimal, COLLATERAL_DECIMALS)],
      }),
    };
  }
}
