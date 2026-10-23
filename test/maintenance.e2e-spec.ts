import { startHarness, type Harness } from "../src/testing/harness";

const DAY = 24 * 60 * 60 * 1000;

describe("/v1/maintenance", () => {
  let harness: Harness;
  const old = new Date(Date.now() - 10 * DAY).toISOString();
  const before = new Date(Date.now() - 2 * DAY).toISOString();

  beforeEach(async () => {
    harness = await startHarness();
    await harness.db.query("DELETE FROM audit_events");
  });

  afterEach(async () => {
    await harness.close();
  });

  async function insert(action: string, outcome: string, createdAt = old): Promise<number> {
    const [row] = await harness.db.query(
      "INSERT INTO audit_events (action, outcome, created_at) VALUES ($1, $2, $3) RETURNING id",
      [action, outcome, createdAt],
    );
    return row.id as number;
  }

  async function count(where = "TRUE"): Promise<number> {
    const [row] = await harness.db.query(
      `SELECT COUNT(*)::int AS n FROM audit_events WHERE ${where}`,
    );
    return row.n as number;
  }

  describe("purge-routine-audit", () => {
    it("deletes only routine success rows older than before, at most batch per call", async () => {
      for (let i = 0; i < 3; i++) await insert("sign.order", "success");
      await insert("meta.redeem", "success");
      await insert("sign.order", "success", new Date().toISOString());
      await insert("sign.order", "failure");
      await insert("meta.withdraw", "success");
      await insert("vault.init", "success");

      const first = await harness.post("/v1/maintenance/purge-routine-audit", {
        body: { before, batch: 3 },
      });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ deleted: 3 });

      const second = await harness.post("/v1/maintenance/purge-routine-audit", {
        body: { before, batch: 3 },
      });
      expect(second.body).toEqual({ deleted: 1 });

      // Recent routine, failures and non-routine actions all survive.
      expect(await count()).toBe(4);
    });

    it("rejects a cutoff newer than 24 hours and a bad batch", async () => {
      const now = await harness.post("/v1/maintenance/purge-routine-audit", {
        body: { before: new Date().toISOString(), batch: 10 },
      });
      expect(now.status).toBe(400);
      expect(now.body.error.code).toBe("VALIDATION_FAILED");

      for (const batch of [0, 5001]) {
        const bad = await harness.post("/v1/maintenance/purge-routine-audit", {
          body: { before, batch },
        });
        expect(bad.status).toBe(400);
      }
    });

    it("rejects a missing key", async () => {
      const response = await harness.post("/v1/maintenance/purge-routine-audit", {
        apiKey: null,
        body: { before, batch: 10 },
      });
      expect(response.status).toBe(401);
    });
  });

  describe("archive scope, export and delete", () => {
    it("exports important rows in id order, never routine ones, and pages by cursor", async () => {
      const ids = [
        await insert("vault.init", "success"),
        await insert("sign.order", "success"),
        await insert("sign.order", "failure"),
        await insert("meta.withdraw", "success"),
        await insert("address.create", "success"),
      ];
      await insert("vault.init", "success", new Date().toISOString());
      const important = [ids[0], ids[2], ids[3], ids[4]];

      const scope = await harness.get(
        `/v1/maintenance/audit-scope?before=${encodeURIComponent(before)}`,
      );
      expect(scope.body).toEqual({ maxId: ids[4], rows: 4 });

      const url = (cursor?: string) =>
        `/v1/maintenance/audit-export?before=${encodeURIComponent(before)}&maxId=${scope.body.maxId}&limit=3` +
        (cursor ? `&cursor=${cursor}` : "");
      const page1 = await harness.get(url());
      expect(page1.status).toBe(200);
      expect(page1.body.items.map((e: { id: number }) => e.id)).toEqual(important.slice(0, 3));
      expect(page1.body.nextCursor).not.toBeNull();

      const page2 = await harness.get(url(page1.body.nextCursor));
      expect(page2.body.items.map((e: { id: number }) => e.id)).toEqual(important.slice(3));
      expect(page2.body.nextCursor).toBeNull();
      expect(page2.body.items[0]).toEqual(
        expect.objectContaining({ action: "address.create", outcome: "success", detail: null }),
      );
    });

    it("never exports or deletes rows inserted after the scope call", async () => {
      await insert("vault.init", "success");
      const scope = await harness.get(
        `/v1/maintenance/audit-scope?before=${encodeURIComponent(before)}`,
      );
      await insert("vault.init", "success");

      const exported = await harness.get(
        `/v1/maintenance/audit-export?before=${encodeURIComponent(before)}&maxId=${scope.body.maxId}`,
      );
      expect(exported.body.items).toHaveLength(1);

      const deleted = await harness.post("/v1/maintenance/delete-archived-audit", {
        body: { before, maxId: scope.body.maxId, batch: 100 },
      });
      expect(deleted.body).toEqual({ deleted: 1 });
      expect(await count()).toBe(1);
    });

    it("deletes exactly the exported set in batches and leaves routine rows", async () => {
      const keep = await insert("sign.order", "success");
      for (let i = 0; i < 3; i++) await insert("meta.withdraw", "success");
      const scope = await harness.get(
        `/v1/maintenance/audit-scope?before=${encodeURIComponent(before)}`,
      );
      const body = { before, maxId: scope.body.maxId, batch: 2 };

      const first = await harness.post("/v1/maintenance/delete-archived-audit", { body });
      const second = await harness.post("/v1/maintenance/delete-archived-audit", { body });
      expect([first.body.deleted, second.body.deleted]).toEqual([2, 1]);
      expect(await count(`id = ${keep}`)).toBe(1);
      expect(await count()).toBe(1);
    });

    it("refuses a cutoff of now on every endpoint, and a missing key", async () => {
      const now = encodeURIComponent(new Date().toISOString());
      expect((await harness.get(`/v1/maintenance/audit-scope?before=${now}`)).status).toBe(400);
      expect((await harness.get(`/v1/maintenance/audit-export?before=${now}&maxId=1`)).status).toBe(
        400,
      );
      const del = await harness.post("/v1/maintenance/delete-archived-audit", {
        body: { before: decodeURIComponent(now), maxId: 1, batch: 1 },
      });
      expect(del.status).toBe(400);

      const noKey = await harness.get(`/v1/maintenance/audit-scope?before=${now}`, {
        apiKey: null,
      });
      expect(noKey.status).toBe(401);
    });

    it("requires maxId and caps the export page at 1000", async () => {
      const b = encodeURIComponent(before);
      expect((await harness.get(`/v1/maintenance/audit-export?before=${b}`)).status).toBe(400);
      expect(
        (await harness.get(`/v1/maintenance/audit-export?before=${b}&maxId=1&limit=1001`)).status,
      ).toBe(400);
    });
  });
});
