import type { Request, Response } from "express";

import type { Db } from "../db/client";
import type { TurnkeyKeyVault } from "../vault/turnkey-vault";
import type { Config } from "../config";
import { HealthController } from "./health.controller";

const KEY = "k".repeat(40);
const CONFIG = { apiKey: KEY } as Config;

function fakeRes(): { res: Response; status: jest.Mock } {
  const status = jest.fn();
  return { res: { status } as unknown as Response, status };
}

describe("HealthController readiness", () => {
  it("answers ok after SELECT 1", async () => {
    const query = jest.fn().mockResolvedValue([{ "?column?": 1 }]);
    const { res, status } = fakeRes();
    const body = await new HealthController(
      {} as TurnkeyKeyVault,
      { query } as unknown as Db,
      CONFIG,
    ).ready(res);
    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(body).toEqual({ status: "ok" });
    expect(status).not.toHaveBeenCalled();
  });

  it("answers 503 unavailable when the query throws", async () => {
    const query = jest.fn().mockRejectedValue(new Error("connection refused"));
    const { res, status } = fakeRes();
    const body = await new HealthController(
      {} as TurnkeyKeyVault,
      { query } as unknown as Db,
      CONFIG,
    ).ready(res);
    expect(status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ status: "unavailable" });
  });

  it("answers 503 when the query hangs past the timeout", async () => {
    jest.useFakeTimers();
    try {
      const query = jest.fn().mockReturnValue(new Promise(() => undefined));
      const { res, status } = fakeRes();
      const pending = new HealthController(
        {} as TurnkeyKeyVault,
        { query } as unknown as Db,
        CONFIG,
      ).ready(res);
      await jest.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual({ status: "unavailable" });
      expect(status).toHaveBeenCalledWith(503);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("HealthController vault detail", () => {
  type FakeVault = { mode: string; initializedState: object | undefined; providerReady: jest.Mock };

  function fakeVault(ready: jest.Mock, initialized = true): FakeVault {
    return {
      mode: "turnkey",
      initializedState: initialized ? { subOrgId: "s", walletId: "w" } : undefined,
      providerReady: ready,
    };
  }

  function controller(vault: FakeVault): HealthController {
    return new HealthController(vault as unknown as TurnkeyKeyVault, {} as Db, CONFIG);
  }

  function request(key?: string): Request {
    return { header: () => key } as unknown as Request;
  }

  it("returns only the status to an unauthenticated caller, without asking the vault", async () => {
    const ready = jest.fn().mockResolvedValue(true);
    const sut = controller(fakeVault(ready));

    expect(await sut.check(request())).toEqual({ status: "ok" });
    expect(await sut.check(request("wrong"))).toEqual({ status: "ok" });
    expect(ready).not.toHaveBeenCalled();
  });

  it("returns the vault detail to a caller with the key, looking Turnkey up at most every 30s", async () => {
    jest.useFakeTimers();
    try {
      const ready = jest.fn().mockResolvedValue(true);
      const sut = controller(fakeVault(ready));

      expect(await sut.check(request(KEY))).toEqual({
        status: "ok",
        vault: { mode: "turnkey", initialized: true, ready: true },
      });
      await sut.check(request(KEY));
      await sut.check(request(KEY));
      expect(ready).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(30_001);
      await sut.check(request(KEY));
      expect(ready).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("reads `initialized` live: init a moment after a cached check shows at once", async () => {
    const ready = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const vault = fakeVault(ready, false);
    const sut = controller(vault);

    expect(await sut.check(request(KEY))).toMatchObject({
      vault: { initialized: false, ready: false },
    });
    vault.initializedState = { subOrgId: "s", walletId: "w" };

    expect(await sut.check(request(KEY))).toMatchObject({
      vault: { initialized: true, ready: true },
    });
  });

  it("does not cache a failed lookup", async () => {
    const ready = jest
      .fn()
      .mockRejectedValueOnce(new Error("turnkey down"))
      .mockResolvedValue(true);
    const sut = controller(fakeVault(ready));

    await expect(sut.check(request(KEY))).rejects.toThrow("turnkey down");
    expect(await sut.check(request(KEY))).toMatchObject({ vault: { ready: true } });
  });
});
