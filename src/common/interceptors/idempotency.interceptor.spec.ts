import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";

import type { IdempotencyRepository } from "../../db/repositories/idempotency.repo";
import { Public } from "../decorators/public.decorator";
import { IdempotencyInterceptor } from "./idempotency.interceptor";

class Controller {
  @Public()
  open(this: void): void {}

  closed(this: void): void {}
}

function contextFor(handler: () => void, method = "POST"): ExecutionContext {
  const request = {
    method,
    originalUrl: "/v1/x",
    body: {},
    header: () => "key-1",
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => Controller,
  } as unknown as ExecutionContext;
}

describe("IdempotencyInterceptor", () => {
  const reserve = jest.fn<Promise<boolean>, []>().mockResolvedValue(true);
  const repository = {
    reserve,
    complete: jest.fn(),
    release: jest.fn(),
    releaseIfStale: jest.fn(),
    find: jest.fn(),
  } as unknown as IdempotencyRepository;
  const interceptor = new IdempotencyInterceptor(repository, new Reflector());
  const next: CallHandler = { handle: () => of("done") };

  beforeEach(() => reserve.mockClear());

  it("passes a @Public POST straight through without touching the store", async () => {
    const result = await interceptor.intercept(contextFor(Controller.prototype.open), next);

    expect(await lastValueFrom(result)).toBe("done");
    expect(reserve).not.toHaveBeenCalled();
  });

  it("reserves for an authenticated POST", async () => {
    const result = await interceptor.intercept(contextFor(Controller.prototype.closed), next);

    expect(await lastValueFrom(result)).toBe("done");
    expect(reserve).toHaveBeenCalledTimes(1);
  });
});
