import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { VaultInitializedGuard } from "../common/guards/vault-initialized.guard";
import { AuditLog } from "../observability/audit";
import { AuditQueryDto } from "./dto/audit-query.dto";

@ApiTags("audit")
@UseGuards(VaultInitializedGuard)
@Controller("audit")
export class AuditController {
  constructor(private readonly audit: AuditLog) {}

  @Get()
  query(@Query() query: AuditQueryDto) {
    const page = this.audit.query(query);
    return {
      events: page.events,
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    };
  }
}
