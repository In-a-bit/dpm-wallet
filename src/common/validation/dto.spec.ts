import type { Type } from "@nestjs/common";

import { AuditQueryDto } from "../../audit/dto/audit-query.dto";
import { CreateAddressDto } from "../../addresses/dto/create-address.dto";
import { DpmRegisteredDto } from "../../addresses/dto/dpm-registered.dto";
import { DpmwError } from "../../errors";
import {
  MetaTxAllowanceDto,
  MetaTxRedeemDto,
  MetaTxSplitDto,
  MetaTxWithdrawDto,
} from "../../meta-tx/dto/meta-tx.dto";
import { SignCancelDto } from "../../sign/dto/sign-cancel.dto";
import { SignOrderDto } from "../../sign/dto/sign-order.dto";
import { PaginationDto } from "../dto/pagination.dto";
import { createValidationPipe } from "./validation-pipe";

/**
 * These DTOs replaced hand-written zod schemas, and several of them normalise as well as
 * check: an address is checksummed, a wei value becomes a bigint, a ref is trimmed, an
 * omitted field takes a default. A silent change to any of those would not fail an
 * end-to-end test — a wrongly-cased address still signs, it just signs the wrong thing — so
 * every transform is pinned here directly.
 */
const pipe = createValidationPipe();

function accept<T>(dto: Type<T>, value: unknown): Promise<T> {
  return pipe.transform(value, { type: "body", metatype: dto, data: "" }) as Promise<T>;
}

/** Returns the `path`/`message` pairs the error envelope would carry. */
async function reject(dto: Type<unknown>, value: unknown): Promise<{ path: string }[]> {
  try {
    await accept(dto, value);
  } catch (err) {
    if (!(err instanceof DpmwError)) throw err;
    expect(err.code).toBe("VALIDATION_FAILED");
    return (err.details as { issues: { path: string }[] }).issues;
  }
  throw new Error("expected the payload to be rejected");
}

const LOWERCASE_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const CHECKSUMMED_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CONDITION_ID = `0x${"cd".repeat(32)}`;
const ORDER_HASH = `0x${"ab".repeat(32)}`;

const ORDER = {
  ref: "customer-1",
  maker: LOWERCASE_ADDRESS,
  side: 0,
  tokenId: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
  shares: 100,
  price: 0.4,
  feeRateBps: 200,
};

describe("address normalisation", () => {
  it("checksums a lowercase address so a handler never sees mixed casing", async () => {
    const order = await accept(SignOrderDto, { ...ORDER, maker: LOWERCASE_ADDRESS });
    expect(order.maker).toBe(CHECKSUMMED_ADDRESS);
  });

  it("accepts an already-checksummed address unchanged", async () => {
    const order = await accept(SignOrderDto, { ...ORDER, maker: CHECKSUMMED_ADDRESS });
    expect(order.maker).toBe(CHECKSUMMED_ADDRESS);
  });

  // A mis-checksummed address is still a valid address; only malformed ones are refused.
  it("rejects a value that is not 20 bytes of hex", async () => {
    const issues = await reject(SignOrderDto, { ...ORDER, maker: "0xnope" });
    expect(issues).toContainEqual({ path: "maker", message: "must be a 20-byte hex address" });
  });
});

describe("defaults for omitted fields", () => {
  it("treats an empty dpm-registered body as a confirmation", async () => {
    expect((await accept(DpmRegisteredDto, {})).registered).toBe(true);
  });

  it("still honours an explicit false", async () => {
    expect((await accept(DpmRegisteredDto, { registered: false })).registered).toBe(false);
  });

  it("defaults a listing to the first 50 rows", async () => {
    expect(await accept(PaginationDto, {})).toEqual({ limit: 50, offset: 0 });
  });
});

describe("pagination bounds", () => {
  it("converts a query string to a number", async () => {
    expect((await accept(PaginationDto, { limit: "200", offset: "10" })).limit).toBe(200);
  });

  it("falls back to the default for an empty parameter", async () => {
    expect((await accept(PaginationDto, { limit: "" })).limit).toBe(50);
  });

  it("refuses a page larger than 200", async () => {
    expect(await reject(PaginationDto, { limit: "201" })).toHaveLength(1);
  });

  it("refuses a page size of zero", async () => {
    expect(await reject(PaginationDto, { limit: "0" })).toHaveLength(1);
  });

  it("refuses a negative offset", async () => {
    expect(await reject(PaginationDto, { offset: "-1" })).toHaveLength(1);
  });
});

describe("trimming", () => {
  it("trims a ref so a stray space cannot fork a customer's directory entry", async () => {
    expect((await accept(CreateAddressDto, { ref: "  customer-1  " })).ref).toBe("customer-1");
  });

  it("rejects a ref that is only whitespace", async () => {
    expect(await reject(CreateAddressDto, { ref: "   " })).not.toHaveLength(0);
  });

  it("rejects a ref beyond 128 characters", async () => {
    expect(await reject(CreateAddressDto, { ref: "a".repeat(129) })).not.toHaveLength(0);
  });

  it("trims a decimal amount", async () => {
    const body = await accept(MetaTxWithdrawDto, {
      ref: "customer-1",
      recipient: CHECKSUMMED_ADDRESS,
      amountDecimal: " 5.5 ",
    });
    expect(body.amountDecimal).toBe("5.5");
  });
});

describe("order fields", () => {
  // z.literal(0) admitted the number and not the string, and implicit conversion is off so
  // that stays true.
  it("rejects a side sent as a string", async () => {
    expect(await reject(SignOrderDto, { ...ORDER, side: "0" })).not.toHaveLength(0);
  });

  it("accepts both sides as numbers", async () => {
    expect((await accept(SignOrderDto, { ...ORDER, side: 1 })).side).toBe(1);
  });

  it("rejects a price above 1", async () => {
    expect(await reject(SignOrderDto, { ...ORDER, price: 1.5 })).not.toHaveLength(0);
  });

  it("rejects a fee rate above 10000 bps", async () => {
    expect(await reject(SignOrderDto, { ...ORDER, feeRateBps: 10001 })).not.toHaveLength(0);
  });

  it("rejects a non-integer fee rate", async () => {
    expect(await reject(SignOrderDto, { ...ORDER, feeRateBps: 1.5 })).not.toHaveLength(0);
  });

  it("rejects a non-decimal token id", async () => {
    expect(await reject(SignOrderDto, { ...ORDER, tokenId: "0xabc" })).not.toHaveLength(0);
  });

  it("leaves an omitted recipient undefined so the exchange pays the maker", async () => {
    expect((await accept(SignOrderDto, ORDER)).recipient).toBeUndefined();
  });

  it("rejects an order hash that is not 32 bytes", async () => {
    const issues = await reject(SignCancelDto, {
      ref: "customer-1",
      orderHash: "0xabc",
      marketId: "market-1",
    });
    expect(issues).toContainEqual({
      path: "orderHash",
      message: "must be a 32-byte hex order hash",
    });
  });

  it("accepts a well-formed cancel", async () => {
    const body = await accept(SignCancelDto, {
      ref: "customer-1",
      orderHash: ORDER_HASH,
      marketId: " market-1 ",
    });
    expect(body.marketId).toBe("market-1");
  });
});

describe("per-kind meta-transaction arguments", () => {
  it("takes only a ref for an allowance", async () => {
    expect(await accept(MetaTxAllowanceDto, { ref: "customer-1" })).toEqual({
      ref: "customer-1",
    });
  });

  // The reason POST /v1/meta-tx/redeem without a condition is a 400 rather than a signature
  // over an undefined position.
  it("requires a condition for a redeem", async () => {
    expect(await reject(MetaTxRedeemDto, { ref: "customer-1" })).not.toHaveLength(0);
  });

  it("requires an amount for a split on top of the condition", async () => {
    expect(
      await reject(MetaTxSplitDto, { ref: "customer-1", conditionId: CONDITION_ID }),
    ).not.toHaveLength(0);
  });

  it("leaves an omitted redeem recipient undefined so the payout stays in the proxy", async () => {
    const body = await accept(MetaTxRedeemDto, { ref: "customer-1", conditionId: CONDITION_ID });
    expect(body.recipient).toBeUndefined();
  });

  it("checksums a redeem recipient", async () => {
    const body = await accept(MetaTxRedeemDto, {
      ref: "customer-1",
      conditionId: CONDITION_ID,
      recipient: LOWERCASE_ADDRESS,
    });
    expect(body.recipient).toBe(CHECKSUMMED_ADDRESS);
  });

  it("rejects a redeem recipient that is not an address", async () => {
    const issues = await reject(MetaTxRedeemDto, {
      ref: "customer-1",
      conditionId: CONDITION_ID,
      recipient: "0xnope",
    });
    expect(issues).toContainEqual({ path: "recipient", message: "must be a 20-byte hex address" });
  });

  // Only redeem forwards a payout. Were split to inherit the field, a request naming a
  // recipient would be accepted and then silently ignored by the builder.
  it("strips a recipient from a split, which has nothing to forward", async () => {
    const body = await accept(MetaTxSplitDto, {
      ref: "customer-1",
      conditionId: CONDITION_ID,
      amountDecimal: "10",
      recipient: CHECKSUMMED_ADDRESS,
    });
    expect(body).not.toHaveProperty("recipient");
  });

  it("rejects a condition id that is not 32 bytes", async () => {
    const issues = await reject(MetaTxRedeemDto, { ref: "customer-1", conditionId: "0xabc" });
    expect(issues).toContainEqual({
      path: "conditionId",
      message: "must be a 32-byte hex condition id",
    });
  });

  it("rejects an amount with more than 18 decimal places", async () => {
    const issues = await reject(MetaTxSplitDto, {
      ref: "customer-1",
      conditionId: CONDITION_ID,
      amountDecimal: `1.${"0".repeat(19)}`,
    });
    expect(issues).toContainEqual({
      path: "amountDecimal",
      message: "must be a positive decimal amount",
    });
  });

  // Unknown properties were stripped rather than refused under zod, and still are.
  it("strips an argument that does not belong to the kind", async () => {
    const body = await accept(MetaTxAllowanceDto, {
      ref: "customer-1",
      conditionId: CONDITION_ID,
    });
    expect(body).toEqual({ ref: "customer-1" });
  });
});

describe("audit filters", () => {
  it("accepts an ISO timestamp with a zone", async () => {
    const query = await accept(AuditQueryDto, { from: "2026-01-01T00:00:00Z" });
    expect(query.from).toBe("2026-01-01T00:00:00Z");
  });

  it("accepts a numeric UTC offset", async () => {
    const query = await accept(AuditQueryDto, { to: "2026-01-01T00:00:00+02:00" });
    expect(query.to).toBe("2026-01-01T00:00:00+02:00");
  });

  // A bare date has no zone, so two operators in different regions would disagree on what it
  // selects.
  it("rejects a timestamp with no zone", async () => {
    expect(await reject(AuditQueryDto, { from: "2026-01-01" })).not.toHaveLength(0);
  });

  it("leaves every filter optional", async () => {
    expect(await accept(AuditQueryDto, {})).toEqual({ limit: 50, offset: 0 });
  });
});
