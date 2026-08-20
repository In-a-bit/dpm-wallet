import { Router } from "express";

import type { Runtime } from "../../runtime.js";
import { signCancelSchema, signOrderSchema } from "../dto/sign.dto.js";

export function signRoutes(runtime: Runtime): Router {
  const router = Router();
  const { addresses, orders } = runtime.services;

  router.post("/sign/order", async (req, res) => {
    const { ref, ...request } = signOrderSchema.parse(req.body);
    res.json(await orders.signOrder(addresses.get(ref), request));
  });

  router.post("/sign/cancel", async (req, res) => {
    const { ref, orderHash, marketId } = signCancelSchema.parse(req.body);
    res.json(await orders.signCancel(addresses.get(ref), orderHash, marketId));
  });

  return router;
}
