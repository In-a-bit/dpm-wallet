import { closeDatabase, openDatabase, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createTestDatabase, type TestDatabase } from "../testing/pg-test-db";
import { assertSchemaPresent } from "./schema-check";

describe("schema check", () => {
  let database: TestDatabase;
  let db: Db;

  beforeEach(async () => {
    database = await createTestDatabase();
    db = await openDatabase(database.url);
  });

  afterEach(async () => {
    await closeDatabase(db);
    await database.drop();
  });

  // Migrating is now a deploy step, so starting against a database nobody migrated is the
  // mistake this has to name — otherwise it surfaces as "relation does not exist" on a
  // customer's first address request and reads as a bug in the service.
  it("refuses an unmigrated database and names the command to run", async () => {
    await expect(assertSchemaPresent(db)).rejects.toThrow(/db:migrate/);
  });

  it("passes once the schema is applied", async () => {
    await runMigrations(db);
    await expect(assertSchemaPresent(db)).resolves.toBeUndefined();
  });

  it("stays satisfied when migrations are re-applied", async () => {
    await runMigrations(db);
    await runMigrations(db);
    await expect(assertSchemaPresent(db)).resolves.toBeUndefined();
  });
});
