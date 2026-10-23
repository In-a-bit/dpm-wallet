import { IsInt, IsOptional, Matches, Max, Min } from "class-validator";

import { IsAtLeastAgo, IsIsoTimestamp, IsPageNumber } from "../../common/validation/decorators";

/** A cutoff newer than this is refused, so a slip can never reach the last day's activity. */
export const MIN_CUTOFF_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_BATCH = 5000;
const MAX_EXPORT_LIMIT = 1000;

function IsCutoff() {
  return (target: object, key: string) => {
    IsIsoTimestamp()(target, key);
    IsAtLeastAgo(MIN_CUTOFF_AGE_MS, "must be at least 24 hours in the past")(target, key);
  };
}

export class AuditScopeQueryDto {
  @IsCutoff()
  before!: string;
}

export class PurgeRoutineAuditDto {
  @IsCutoff()
  before!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_BATCH)
  batch!: number;
}

export class DeleteArchivedAuditDto extends PurgeRoutineAuditDto {
  @IsInt()
  @Min(0)
  maxId!: number;
}

export class AuditExportQueryDto {
  @IsCutoff()
  before!: string;

  @IsPageNumber(0, { min: 0 })
  maxId!: number;

  @IsOptional()
  @Matches(/^\d{1,15}$/, { message: "must be a cursor returned by a previous page" })
  cursor?: string;

  @IsPageNumber(100, { min: 1, max: MAX_EXPORT_LIMIT })
  limit: number = 100;
}
