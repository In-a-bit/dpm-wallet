import { IsPageNumber } from "../validation/decorators";

/**
 * The bound on result size for every listing endpoint. The initializers are the defaults an
 * omitted parameter falls back to; see `IsPageNumber` for why they live here rather than in
 * the transform.
 */
export class PaginationDto {
  @IsPageNumber(50, { min: 1, max: 200 })
  limit: number = 50;

  @IsPageNumber(0, { min: 0 })
  offset: number = 0;
}
