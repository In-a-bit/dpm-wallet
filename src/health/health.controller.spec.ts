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
  const HEALTH = { mode: "turnkey", initialized: true, ready: true };

  function controller(health: jest.Mock): HealthController {
    return new HealthController({ health } as unknown as TurnkeyKeyVault, {} as Db, CONFIG);
  }

  function request(key?: string): Request {
    return { header: () => key } as unknown as Request;
  }

  it("returns only the status to an unauthenticated caller, without asking the vault", async () => {
    const health = jest.fn().mockResolvedValue(HEALTH);
    const sut = controller(health);

    expect(await sut.check(request())).toEqual({ status: "ok" });
    expect(await sut.check(request("wrong"))).toEqual({ status: "ok" });
    expect(health).not.toHaveBeenCalled();
  });

  it("returns the vault detail to a caller with the key, looked up at most every 30s", async () => {
    jest.useFakeTimers();
    try {
      const health = jest.fn().mockResolvedValue(HEALTH);
      const sut = controller(health);

      expect(await sut.check(request(KEY))).toEqual({ status: "ok", vault: HEALTH });
      await sut.check(request(KEY));
      await sut.check(request(KEY));
      expect(health).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(30_001);
      await sut.check(request(KEY));
      expect(health).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not cache a failed lookup", async () => {
    const health = jest
      .fn()
      .mockRejectedValueOnce(new Error("turnkey down"))
      .mockResolvedValue(HEALTH);
    const sut = controller(health);

    await expect(sut.check(request(KEY))).rejects.toThrow("turnkey down");
    expect(await sut.check(request(KEY))).toEqual({ status: "ok", vault: HEALTH });
  });
});
