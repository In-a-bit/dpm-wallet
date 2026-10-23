import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { AuditRepository } from "../db/repositories/audit.repo";
import {
  AuditExportQueryDto,
  AuditScopeQueryDto,
  DeleteArchivedAuditDto,
  PurgeRoutineAuditDto,
} from "./dto/maintenance.dto";

/**
 * Driven by dpm-wallet-manager: it picks the cutoffs, this service only applies them. Routine
 * rows go in batches; important rows leave only after an operator has downloaded the archive
 * (`audit-scope` fixes the id ceiling, `audit-export` pages it, `delete-archived-audit` removes it).
 */
@ApiTags("maintenance")
@Controller("maintenance")
export class MaintenanceController {
  constructor(private readonly audit: AuditRepository) {}

  @Post("purge-routine-audit")
  @HttpCode(200)
  async purgeRoutineAudit(@Body() body: PurgeRoutineAuditDto) {
    return { deleted: await this.audit.purgeRoutine(body.before, body.batch) };
  }

  @Get("audit-scope")
  auditScope(@Query() query: AuditScopeQueryDto) {
    return this.audit.importantScope(query.before);
  }

  @Get("audit-export")
  async auditExport(@Query() query: AuditExportQueryDto) {
    const items = await this.audit.exportImportant({
      before: query.before,
      maxId: query.maxId,
      afterId: query.cursor === undefined ? undefined : Number(query.cursor),
      limit: query.limit,
    });
    const last = items.at(-1);
    // A short page is the end; a full one may be followed by more, so hand back where to resume.
    const nextCursor = last && items.length === query.limit ? String(last.id) : null;
    return { items, nextCursor };
  }

  @Post("delete-archived-audit")
  @HttpCode(200)
  async deleteArchivedAudit(@Body() body: DeleteArchivedAuditDto) {
    const deleted = await this.audit.deleteArchived(
      { before: body.before, maxId: body.maxId },
      body.batch,
    );
    return { deleted };
  }
}
