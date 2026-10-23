import {
  IDEMPOTENCY_RETENTION_MS,
  type IdempotencyRepository,
} from "../db/repositories/idempotency.repo";
import { RetentionService } from "./retention.service";

describe("RetentionService", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("purges idempotency keys older than 24 hours", async () => {
    const purgeOlderThan = jest.fn().mockResolvedValue(3);
    const service = new RetentionService({ purgeOlderThan } as unknown as IdempotencyRepository);
    const now = Date.now();

    await service.runOnce();

    const cutoff = Date.parse(purgeOlderThan.mock.calls[0][0] as string);
    expect(IDEMPOTENCY_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
    expect(Math.abs(now - IDEMPOTENCY_RETENTION_MS - cutoff)).toBeLessThan(5000);
  });

  it("swallows a failure and does not overlap runs", async () => {
    let release!: () => void;
    const purgeOlderThan = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise<number>((_, reject) => (release = () => reject(new Error("db down")))),
      )
      .mockResolvedValue(0);
    const service = new RetentionService({ purgeOlderThan } as unknown as IdempotencyRepository);

    const first = service.runOnce();
    await service.runOnce();
    expect(purgeOlderThan).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBeUndefined();
    await service.runOnce();
    expect(purgeOlderThan).toHaveBeenCalledTimes(2);
  });

  it("first runs after 60 s, then hourly, and stops on destroy", async () => {
    jest.useFakeTimers();
    const purgeOlderThan = jest.fn().mockResolvedValue(0);
    const service = new RetentionService({ purgeOlderThan } as unknown as IdempotencyRepository);

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(59_000);
    expect(purgeOlderThan).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(purgeOlderThan).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(purgeOlderThan).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(purgeOlderThan).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});
