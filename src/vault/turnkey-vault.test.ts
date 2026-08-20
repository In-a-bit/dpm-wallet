import { hashMessage, recoverAddress, recoverMessageAddress, verifyTypedData } from "viem";
import { beforeEach, describe, expect, it } from "vitest";

import { MASTER_DERIVATION_INDEX, MASTER_REF } from "../db/repositories/wallet.repo.js";
import { FakeSignerProvider } from "../testing/fake-signer-provider.js";
import { derivationPath } from "./key-vault.interface.js";
import { TurnkeyKeyVault } from "./turnkey-vault.js";

const STRUCT_HASH = "0xf6d45df6ddeb59a2287f1d6fa541907c1ab607f061a5c9bf5a9a4f11c6ec4a9e";
const CANCEL_MESSAGE = "Cancel order: 0xabc on market: market-1";

const ORDER_TYPED_DATA = {
  types: {
    Order: [
      { name: "salt", type: "uint256" },
      { name: "maker", type: "address" },
    ],
  },
  domain: {
    name: "DPM CTF Exchange",
    version: "1",
    chainId: 137,
    verifyingContract: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  },
  primaryType: "Order",
  message: { salt: 1n, maker: "0x1111111111111111111111111111111111111111" },
} as const;

describe("TurnkeyKeyVault", () => {
  let provider: FakeSignerProvider;
  let vault: TurnkeyKeyVault;

  beforeEach(async () => {
    provider = new FakeSignerProvider();
    vault = new TurnkeyKeyVault(provider);
    await adoptInitializedState(vault, provider);
  });

  describe("personalSign", () => {
    // The rlx: struct hash is hex and must be signed as raw bytes; a cancel message is
    // plaintext. Hashing either the other way signs the wrong preimage, and the RelayHub or the
    // exchange rejects it with no indication of why.
    it("signs a hex struct hash as raw bytes", async () => {
      const account = await vault.createAccount(1, "customer-1");
      const signature = await vault.personalSign(account.address, STRUCT_HASH);

      const recovered = await recoverAddress({
        hash: hashMessage({ raw: STRUCT_HASH }),
        signature,
      });
      expect(recovered).toBe(account.address);
    });

    it("signs a plaintext message as UTF-8", async () => {
      const account = await vault.createAccount(1, "customer-1");
      const signature = await vault.personalSign(account.address, CANCEL_MESSAGE);

      const recovered = await recoverMessageAddress({ message: CANCEL_MESSAGE, signature });
      expect(recovered).toBe(account.address);
    });

    it("does not treat a non-hex 0x-prefixed string as bytes", async () => {
      const account = await vault.createAccount(1, "customer-1");
      const message = "0xnot-hex-at-all";
      const signature = await vault.personalSign(account.address, message);

      const recovered = await recoverMessageAddress({ message, signature });
      expect(recovered).toBe(account.address);
    });
  });

  it("produces a verifiable EIP-712 signature", async () => {
    const account = await vault.createAccount(1, "customer-1");
    const signature = await vault.signTypedData(account.address, ORDER_TYPED_DATA);

    await expect(
      verifyTypedData({ ...ORDER_TYPED_DATA, address: account.address, signature }),
    ).resolves.toBe(true);
  });

  it("derives accounts at the BIP-44 path so indices are stable", async () => {
    const first = await vault.createAccount(1, "customer-1");
    const again = await vault.createAccount(1, "customer-1");
    const second = await vault.createAccount(2, "customer-2");

    expect(again.address).toBe(first.address);
    expect(second.address).not.toBe(first.address);
  });

  it("puts the master at index 0, ahead of every user wallet", async () => {
    const master = vault.initializedState?.master;
    const firstUser = await vault.createAccount(1, "customer-1");

    expect(master?.index).toBe(MASTER_DERIVATION_INDEX);
    expect(master?.address).not.toBe(firstUser.address);
  });
});

/**
 * Puts the vault where first init leaves it: credentials adopted, and the master account
 * that the sub-organisation call created already held by the provider.
 */
async function adoptInitializedState(
  vault: TurnkeyKeyVault,
  provider: FakeSignerProvider,
): Promise<void> {
  const credentials = {
    subOrgId: "sub-org-1",
    walletId: "wallet-1",
    apiPublicKey: "02fake",
    apiPrivateKey: "fake-private-key",
  };
  provider.adoptCredentials(credentials);
  const master = await provider.createAccount(
    derivationPath(MASTER_DERIVATION_INDEX),
    MASTER_REF,
  );
  vault.adopt({
    subOrgId: credentials.subOrgId,
    walletId: credentials.walletId,
    master: {
      address: master.address,
      index: MASTER_DERIVATION_INDEX,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
}
