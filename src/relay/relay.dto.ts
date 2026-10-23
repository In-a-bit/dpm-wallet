import { Allow, IsEthereumAddress } from "class-validator";

/**
 * A `SubmitTransactionRequest` as `/v1/meta-tx/*` produced it. Only `from` is checked here,
 * because it decides who the relayer is asked to act for; the rest is the signed payload, and
 * the relayer validates it. `@Allow` keeps those fields past the whitelist, and `from` is
 * deliberately not normalised: the request is relayed exactly as signed.
 */
export class RelaySubmitDto {
  @IsEthereumAddress()
  from!: string;

  @Allow() to!: string;
  @Allow() proxyWallet?: string;
  @Allow() data!: string;
  @Allow() nonce!: string;
  @Allow() signature!: string;
  @Allow() signatureParams!: Record<string, string | undefined>;
  @Allow() type!: "PROXY";
  @Allow() metadata?: string;
}

export class RelayStatusQueryDto {
  @IsEthereumAddress()
  from!: string;
}
