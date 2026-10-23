import { privateKeyToAddress } from "viem/accounts";

import { createTestDatabase, type TestDatabase } from "../../testing/pg-test-db";
import { closeDatabase, openDatabase, type Db } from "../client";
import { runMigrations } from "../migrate";
import { WalletRepository } from "./wallet.repo";

describe("WalletRepository paging", () => {
  let database: TestDatabase;
  let db: Db;
  let wallets: WalletRepository;

  const address = (n: number) => privateKeyToAddress(`0x${(n + 1).toString(16).padStart(64, "0")}`);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = await openDatabase(database.url);
    await runMigrations(db);
    wallets = new WalletRepository(db);
    for (let i = 0; i < 5; i += 1) {
      await wallets.insert({
        ref: `ref-${i}`,
        derivationIndex: i,
        eoaAddress: address(i),
        proxyAddress: address(i + 100),
        turnkeyAccountId: null,
        createdAt: new Date().toISOString(),
      });
    }
  });

  afterAll(async () => {
    await closeDatabase(db);
    await database.drop();
  });

  // The boot-time vault check walks the whole directory; it must do so a page at a time.
  it("walks EOA addresses in derivation order, limit rows at a time", async () => {
    const first = await wallets.eoaAddressPage(-1, 2);
    expect(first.addresses).toEqual([address(0), address(1)]);
    expect(first.lastIndex).toBe(1);

    const second = await wallets.eoaAddressPage(first.lastIndex, 2);
    expect(second.addresses).toEqual([address(2), address(3)]);

    const third = await wallets.eoaAddressPage(second.lastIndex, 2);
    expect(third.addresses).toEqual([address(4)]);

    const done = await wallets.eoaAddressPage(third.lastIndex, 2);
    expect(done.addresses).toEqual([]);
  });
});
