import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";

import { PaginationDto } from "../../common/dto/pagination.dto";
import { IsIsoTimestamp, IsRef, Trimmed } from "../../common/validation/decorators";

const MAX_ACTION_LENGTH = 64;
/** audit_events.id is a 4-byte serial; anything larger can never match and would 500 in Postgres. */
const MAX_CURSOR_ID = 2_147_483_647;

/** The cursor is the base64url of the last id; null when it is anything else. */
export function decodeAuditCursor(cursor: string): number | null {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[1-9]\d{0,9}$/.test(text)) return null;
  const id = Number(text);
  return id <= MAX_CURSOR_ID && Buffer.from(text).toString("base64url") === cursor ? id : null;
}

export function encodeAuditCursor(id: number): string {
  return Buffer.from(String(id)).toString("base64url");
}

@ValidatorConstraint({ name: "isAuditCursor" })
class IsAuditCursor implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === "string" && decodeAuditCursor(value) !== null;
  }
  defaultMessage(): string {
    return "must be a cursor returned by a previous page";
  }
}

/**
 * `from`/`to` are optional filters, not the bound on result size — that comes from
 * `PaginationDto`, which defaults `limit` to 50 and rejects anything above 200. Omitting
 * the range widens what matches, never how much comes back.
 */
export class AuditQueryDto extends PaginationDto {
  @IsOptional()
  @IsRef()
  ref?: string;

  @IsOptional()
  @Trimmed()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_ACTION_LENGTH)
  action?: string;

  @IsOptional()
  @IsIsoTimestamp()
  from?: string;

  @IsOptional()
  @IsIsoTimestamp()
  to?: string;

  /**
   * Opaque cursor from a previous page's `nextCursor`. Presence switches to keyset paging:
   * `offset` is ignored and `total` omitted. Offset paging (no cursor) is deprecated.
   */
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,16}$/, { message: "must be a cursor returned by a previous page" })
  @Validate(IsAuditCursor)
  cursor?: string;
}
