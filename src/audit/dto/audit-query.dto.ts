import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

import { PaginationDto } from "../../common/dto/pagination.dto";
import { IsIsoTimestamp, IsRef, Trimmed } from "../../common/validation/decorators";

const MAX_ACTION_LENGTH = 64;

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
}
