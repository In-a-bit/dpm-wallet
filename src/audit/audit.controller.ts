import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { VaultInitializedGuard } from "../common/guards/vault-initialized.guard";
import { AuditLog } from "../observability/audit";
import { AuditQueryDto, decodeAuditCursor, encodeAuditCursor } from "./dto/audit-query.dto";

@ApiTags("audit")
@UseGuards(VaultInitializedGuard)
@Controller("audit")
export class AuditController {
  constructor(private readonly audit: AuditLog) {}

  @Get()
  @ApiOperation({
    description:
      "Newest first. Page with `cursor` (the previous response's `nextCursor`): stable while new " +
      "events arrive, and `total` is omitted. Offset paging (`offset`, without `cursor`) is " +
      "deprecated; it still returns `total` and `offset`.",
  })
  async query(@Query() query: AuditQueryDto) {
    const beforeId =
      query.cursor === undefined ? undefined : (decodeAuditCursor(query.cursor) ?? undefined);
    const page = await this.audit.query({ ...query, beforeId });
    const nextCursor = page.nextId === null ? null : encodeAuditCursor(page.nextId);
    if (beforeId !== undefined) {
      return { events: page.events, limit: query.limit, nextCursor };
    }
    return {
      events: page.events,
      total: page.total,
      limit: query.limit,
      offset: query.offset,
      nextCursor,
    };
  }
}
