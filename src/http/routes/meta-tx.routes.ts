import { Router, type RequestHandler } from "express";

import type { Runtime } from "../../runtime.js";
import { META_TX_KINDS, type MetaTxKind } from "../../sdk/wiring.js";
import { META_TX_SCHEMAS } from "../dto/meta-tx.dto.js";

/**
 * The five endpoints differ only in their schema and the SDK builder behind them, so they are
 * registered from one table. Each returns a complete `SubmitTransactionRequest` the operator
 * POSTs verbatim to `relayer-api`.
 */
export function metaTxRoutes(runtime: Runtime): Router {
  const router = Router();
  for (const kind of META_TX_KINDS) {
    router.post(`/meta-tx/${kind}`, buildHandler(runtime, kind));
  }
  return router;
}

function buildHandler(runtime: Runtime, kind: MetaTxKind): RequestHandler {
  const schema = META_TX_SCHEMAS[kind];
  return async (req, res) => {
    const { ref, ...args } = schema.parse(req.body ?? {});
    const wallet = runtime.services.addresses.get(ref);
    res.json(await runtime.services.metaTx.build(kind, wallet, args));
  };
}
