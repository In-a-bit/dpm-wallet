import { Router } from "express";

import type { Runtime } from "../../runtime.js";
import {
  externalWithdrawSchema,
  fundProxySchema,
  sweepSchema,
} from "../dto/treasury.dto.js";

/**
 * The three raw-transaction movements the treasury allows. A user's tradable balance moves
 * out of their proxy through `POST /v1/meta-tx/withdraw` instead, because only the RelayHub
 * can spend from a proxy.
 */
export function treasuryRoutes(runtime: Runtime): Router {
  const router = Router();
  const { addresses, treasury } = runtime.services;

  router.post("/treasury/fund-proxy", async (req, res) => {
    const { to, ...amount } = fundProxySchema.parse(req.body);
    res.json(await treasury.fundProxy(addresses.get(to), amount));
  });

  router.post("/treasury/external-withdraw", async (req, res) => {
    res.json(await treasury.externalWithdraw(externalWithdrawSchema.parse(req.body)));
  });

  router.post("/treasury/sweep", async (req, res) => {
    const { from, ...transfer } = sweepSchema.parse(req.body);
    res.json(await treasury.sweepToMaster(addresses.get(from), transfer));
  });

  return router;
}
