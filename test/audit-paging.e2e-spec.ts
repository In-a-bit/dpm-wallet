import { startHarness, type Harness } from "../src/testing/harness";

describe("GET /v1/audit cursor paging", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
    await harness.post("/v1/vault/init");
    await harness.db.query("DELETE FROM audit_events");
    await insertRows(120);
  });

  afterEach(async () => {
    await harness.close();
  });

  async function insertRows(n: number): Promise<void> {
    await harness.db.query(
      `INSERT INTO audit_events (action, outcome, created_at)
       SELECT 'sign.order', 'success', now() FROM generate_series(1, $1)`,
      [n],
    );
  }

  const ids = (events: { id: number }[]) => events.map((e) => e.id);

  it("pages 50/50/20 without overlap, no total, last nextCursor null", async () => {
    const one = await harness.get("/v1/audit?limit=50");
    expect(one.body.total).toBe(120);
    const first = await harness.get("/v1/audit?limit=50&cursor=" + one.body.nextCursor);
    expect(first.status).toBe(200);
    const two = first.body;
    const three = (await harness.get("/v1/audit?limit=50&cursor=" + two.nextCursor)).body;

    expect([one.body.events.length, two.events.length, three.events.length]).toEqual([50, 50, 20]);
    expect(three.nextCursor).toBeNull();
    expect(two).not.toHaveProperty("total");
    expect(three).not.toHaveProperty("total");
    const all = [...ids(one.body.events), ...ids(two.events), ...ids(three.events)];
    expect(new Set(all).size).toBe(120);
    expect(all).toEqual([...all].sort((a, b) => b - a));
  });

  it("is stable when newer rows arrive between pages", async () => {
    const reference = await harness.get("/v1/audit?limit=200");
    const one = await harness.get("/v1/audit?limit=50");
    await insertRows(5);
    const two = await harness.get("/v1/audit?limit=50&cursor=" + one.body.nextCursor);
    expect(ids(two.body.events)).toEqual(ids(reference.body.events.slice(50, 100)));
  });

  it("keeps offset mode as it was, plus nextCursor", async () => {
    const response = await harness.get("/v1/audit?limit=50&offset=10");
    expect(response.body).toMatchObject({ total: 120, limit: 50, offset: 10 });
    expect(response.body.events).toHaveLength(50);
    expect(typeof response.body.nextCursor).toBe("string");
    const tail = await harness.get("/v1/audit?limit=50&offset=100");
    expect(tail.body.nextCursor).toBeNull();
  });

  it("rejects bad cursors with 400", async () => {
    const huge = Buffer.from("99999999999").toString("base64url");
    const over = Buffer.from("2147483648").toString("base64url");
    const letters = Buffer.from("abc").toString("base64url");
    for (const cursor of ["garbage!", "abc", huge, over, letters, "MA"]) {
      const response = await harness.get(`/v1/audit?cursor=${cursor}`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_FAILED");
    }
  });
});
