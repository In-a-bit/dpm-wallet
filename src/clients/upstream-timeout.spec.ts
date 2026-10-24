import { withDeadline } from "./upstream-timeout";

describe("withDeadline", () => {
  afterEach(() => jest.useRealTimers());

  it("passes through what settles first", async () => {
    await expect(withDeadline(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error("boom")), 1000, "x")).rejects.toThrow(
      "boom",
    );
  });

  it("rejects a call that never settles, naming it", async () => {
    jest.useFakeTimers();
    const pending = withDeadline(
      new Promise<never>(() => undefined),
      60_000,
      "Turnkey signRawPayload",
    );
    const outcome = expect(pending).rejects.toThrow(
      "Turnkey signRawPayload timed out after 60000ms",
    );
    await jest.advanceTimersByTimeAsync(60_000);
    await outcome;
  });

  it("leaves no timer behind once the work settles", async () => {
    jest.useFakeTimers();
    await withDeadline(Promise.resolve(1), 60_000, "x");
    expect(jest.getTimerCount()).toBe(0);
  });
});
