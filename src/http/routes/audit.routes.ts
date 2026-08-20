import { Router } from "express";

import type { Runtime } from "../../runtime.js";
import { auditQuerySchema } from "../dto/audit.dto.js";

export function auditRoutes(runtime: Runtime): Router {
  const router = Router();

  router.get("/audit", (req, res) => {
    const query = auditQuerySchema.parse(req.query);
    const page = runtime.audit.query(query);
    res.json({
      events: page.events,
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    });
  });

  return router;
}
