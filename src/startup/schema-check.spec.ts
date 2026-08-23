import { closeDatabase, openDatabase } from "../db/client";
import { runMigrations } from "../db/migrate";
import { assertSchemaPresent } from "./schema-check";

describe("schema check", () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  // Migrating is now a deploy step, so starting against a volume nobody migrated is the
  // mistake this has to name — otherwise it surfaces as "no such table" on a customer's
  // first address request and reads as a bug in the service.
  it("refuses an unmigrated database and names the command to run", () => {
    expect(() => assertSchemaPresent(db)).toThrow(/db:migrate/);
  });

  it("passes once the schema is applied", () => {
    runMigrations(db);
    expect(() => assertSchemaPresent(db)).not.toThrow();
  });

  it("stays satisfied when migrations are re-applied", () => {
    runMigrations(db);
    runMigrations(db);
    expect(() => assertSchemaPresent(db)).not.toThrow();
  });
});
