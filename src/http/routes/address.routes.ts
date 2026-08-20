import { Router } from "express";

import type { Wallet } from "../../db/repositories/wallet.repo.js";
import type { Runtime } from "../../runtime.js";
import {
  createAddressSchema,
  dpmRegisteredSchema,
  listAddressesSchema,
} from "../dto/address.dto.js";
import { refSchema } from "../dto/common.dto.js";

export function addressRoutes(runtime: Runtime): Router {
  const router = Router();
  const { addresses } = runtime.services;

  router.post("/addresses", async (req, res) => {
    const { ref } = createAddressSchema.parse(req.body);
    res.json(toResponse(await addresses.create(ref)));
  });

  router.get("/addresses", (req, res) => {
    const { limit, offset } = listAddressesSchema.parse(req.query);
    const page = addresses.list(limit, offset);
    res.json({ addresses: page.wallets.map(toResponse), total: page.total, limit, offset });
  });

  router.get("/addresses/:ref", (req, res) => {
    res.json(toResponse(addresses.get(refSchema.parse(req.params.ref))));
  });

  // Not in the original spec, which describes `wallets.dpm_registered` without giving the
  // operator a way to set it. Meta-transaction signing gates on the flag, so the gateway
  // needs this call after the DPM platform confirms registration.
  router.post("/addresses/:ref/dpm-registered", (req, res) => {
    const ref = refSchema.parse(req.params.ref);
    const { registered } = dpmRegisteredSchema.parse(req.body ?? {});
    res.json(toResponse(addresses.setDpmRegistered(ref, registered)));
  });

  return router;
}

function toResponse(wallet: Wallet) {
  return {
    ref: wallet.ref,
    role: wallet.role,
    index: wallet.derivationIndex,
    address: wallet.eoaAddress,
    proxyAddress: wallet.proxyAddress,
    dpmRegistered: wallet.dpmRegistered,
    createdAt: wallet.createdAt,
  };
}
