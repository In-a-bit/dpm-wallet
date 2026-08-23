import {
  buildOrderFields,
  buildOrderTypedData,
  EXCHANGE_DOMAIN_NAME,
  formatCancelOrderMessage,
  type OrderFields,
  type OrderParams,
} from "@inabit-com/dpm-sdk/server";
import { Inject, Injectable } from "@nestjs/common";
import { hashTypedData, toHex, type Address, type Hex, type TypedDataDefinition } from "viem";

import type { Config } from "../config";
import type { Wallet } from "../db/repositories/wallet.repo";
import { AuditAction } from "../observability/audit-action";
import { AuditLog } from "../observability/audit";
import { CONFIG, KEY_VAULT } from "../tokens";
import type { KeyVault } from "../vault/key-vault.interface";

export type SignOrderRequest = {
  /** Operator-supplied source of funds; signed as given and never overridden. */
  maker: Address;
  side: 0 | 1;
  tokenId: string;
  shares: number;
  price: number;
  feeRateBps: number;
  /** Optional; omitted or zero means the exchange pays the maker. */
  recipient?: Address;
};

export type SignedOrder = {
  order: OrderFields;
  signature: Hex;
  orderHash: Hex;
};

export type SignedCancel = {
  signer: Address;
  message: string;
  signature: Hex;
};

/**
 * Produces signed orders and cancellations. Every field except `signer` comes from the
 * operator: the wallet ref selects the key, and that key's EOA becomes `signer`.
 *
 * Deliberately validates neither `maker` nor `recipient` against the address directory.
 * Deciding which addresses may fund an order or receive its proceeds needs ledger context
 * this service does not have, so it belongs in the operator gateway.
 */
@Injectable()
export class OrderSignerService {
  constructor(
    private readonly audit: AuditLog,
    @Inject(KEY_VAULT) private readonly vault: KeyVault,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async signOrder(wallet: Wallet, request: SignOrderRequest): Promise<SignedOrder> {
    const order = this.buildOrder(wallet, request);
    const typedData = this.typedDataFor(order);
    const signature = await this.vault.signTypedData(wallet.eoaAddress, typedData);
    const orderHash = hashTypedData(typedData);
    this.audit.record({
      ref: wallet.ref,
      action: AuditAction.SignOrder,
      outcome: "success",
      detail: {
        orderHash,
        maker: order.maker,
        signer: order.signer,
        recipient: order.recipient,
        tokenId: order.tokenId,
        side: order.side,
        signature,
      },
    });
    return { order, signature, orderHash };
  }

  /**
   * The plaintext is converted to hex before signing so the vault takes the raw-bytes
   * branch, matching what browser providers do with `personal_sign`. Both paths hash the
   * same bytes, so the exchange recovers the same signer either way.
   */
  async signCancel(wallet: Wallet, orderHash: string, marketId: string): Promise<SignedCancel> {
    const message = formatCancelOrderMessage(orderHash, marketId);
    const signature = await this.vault.personalSign(wallet.eoaAddress, toHex(message));
    this.audit.record({
      ref: wallet.ref,
      action: AuditAction.SignCancel,
      outcome: "success",
      detail: { orderHash, marketId, signature },
    });
    return { signer: wallet.eoaAddress, message, signature };
  }

  private buildOrder(wallet: Wallet, request: SignOrderRequest): OrderFields {
    const params: OrderParams = {
      side: request.side,
      tokenId: request.tokenId,
      shares: request.shares,
      price: request.price,
      feeRateBps: request.feeRateBps,
      ...(request.recipient ? { recipient: request.recipient } : {}),
    };
    // buildOrderFields sets both maker and signer from its second argument; the signer is
    // then replaced with the EOA that actually holds the key.
    const order = buildOrderFields(params, request.maker);
    order.signer = wallet.eoaAddress;
    return order;
  }

  /**
   * The domain name is the SDK's constant, not config: it is fixed by the deployed
   * exchange, and a wrong value produces valid signatures the exchange silently rejects.
   * The boot self-check pins the digest it yields.
   */
  private typedDataFor(order: OrderFields): TypedDataDefinition {
    return buildOrderTypedData(
      order,
      this.config.chainId,
      this.config.contracts.ctfExchange,
      EXCHANGE_DOMAIN_NAME,
    ) as TypedDataDefinition;
  }
}
