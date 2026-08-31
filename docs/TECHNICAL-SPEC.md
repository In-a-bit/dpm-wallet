# DPM Wallet (dpmw) — Technical Specification

Version: 0.2 (draft) · Status: for review · Owner: Plaee DPM

---

## 1. Summary

The DPM Wallet (`dpmw`) is a lightweight, operator-hosted TypeScript service that does two things and nothing else:

1. **Creates and manages blockchain addresses** for an operator and its customers.
2. **Signs payloads** — trading orders and proxy meta-transactions (allowance, redeem, withdrawal).

It is delivered as a single Docker image that each operator runs inside their own infrastructure. The only caller into the `dpmw` is the operator's backend (the "Operator DPM Gateway"). The `dpmw` never talks to Plaee except for one read-only call needed to assemble a meta-transaction (see [Section 5](#5-trust-boundary-and-outbound-dependencies)).

It signs **agnostically**. The `dpmw` has no view of balances and performs no balance reads, monitoring, or validation: it signs what the operator asks it to sign, with the parameters the operator supplies. Whether a signed artefact is economically valid — funded, within limits, against a real position — is the operator's and Plaee's concern, not the `dpmw`'s.

Key custody sits behind one pluggable interface, but **phase 1 ships Turnkey only**: private keys live in the Turnkey TEE and the service asks Turnkey to sign, holding no key material of its own. A self-custody (mnemonic) mode or a different provider (e.g. Fireblocks) drops in behind the same interface later without touching business logic (see [Section 13](#13-deferred-capabilities)).

The service is built on top of the existing `dpm-sdk` rather than reimplementing any cryptography. All EIP-712 order construction, proxy-call encoding, and RelayHub struct hashing is reused from the SDK, which is vendored into the image.

---



## 2. Goals and non-goals



### 2.1 Goals (v1)

- Generate and persist any number of **wallets**, all with identical capabilities.
- Derive and return each wallet's **on-chain proxy wallet address** without a chain round-trip.
- Sign **CLOB orders** (EIP-712) and return the signed order to the operator.
- Build and sign **proxy meta-transactions** — USDC/CTF allowance, redeem, proxy withdrawal, split, merge — and return a ready-to-submit request body to the operator.
- Maintain a **secure address directory** (wallet reference → EOA → proxy → derivation index) in an embedded database.
- Authenticate every inbound request from the operator with an **API key**.
- Emit **structured audit logs** for every address creation and signing action.



### 2.2 Non-goals (v1 — deferred, not stubbed)

These appear in the product PDF but are explicitly deferred. Where the `dpmw` will eventually own the capability, the interface seam already exists so it drops in later without redesign; where it will not, the work belongs elsewhere (see §2.3).

- **Self-custody (mnemonic) vault mode.** Phase 1 is Turnkey-only; the `KeyVault` port ([Section 6.2](#62-the-keyvault-port)) is the seam a mnemonic vault drops into later.
- **Per-user** `recipientId` **trading ledger** (orders/fills/positions per customer).
- **WebSocket event streaming** to PlaeeOS.
- **Broadcasting** any transaction to Polygon. The `dpmw` signs; the operator (or Plaee) broadcasts.



### 2.3 Explicitly out of scope forever

- Submitting orders or meta-transactions to Plaee. The `dpmw` returns signed artefacts to the operator, who routes them onward.
- **Any balance awareness.** The `dpmw` does not read, monitor, track, or validate balances — on-chain or otherwise. It never checks that a wallet can afford what it is signing for, and it runs no chain watcher. On-chain deposit/withdrawal monitoring and confirmation tracking belong to Plaee and the operator.
- Holding or reconciling customer balances. That is the operator's ledger and Plaee's shared-balance DB.
- Modelling the **operational wallet**. That is a Plaee-side *shared-balance* concept; inside the `dpmw` the address backing it is an ordinary wallet, indistinguishable from any other (see [Section 6.3](#63-the-derivation-model)).

---



## 3. Confirmed design decisions

These were settled with the product owner and are treated as fixed for this spec.


| #   | Decision                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The `dpmw` is **sign-only**. It never submits to Plaee.                                                                                                                                                                                        |
| 2   | It is **built on** `dpm-sdk`, vendored and compiled inside the image. No re-implementation of encoding/hashing.                                                                                                                                |
| 3   | It has exactly **one outbound dependency to Plaee**: `GET /relay-payload` on `relayer-api`.                                                                                                                                                    |
| 4   | **v1 scope** is address management and signing — nothing else. Monitoring, ledger, and WebSocket are other systems' work, not stubs inside this one.                                                                                           |
| 5   | The EIP-712 order **domain name is** `"DPM CTF Exchange"` (a change is required in `dpm-sdk`; see [Section 7](#7-dpm-sdk-integration-and-required-changes)).                                                                                   |
| 6   | Orders carry an **optional** `recipient` **address**, not an identifier. If omitted (or zero), the exchange pays the **maker**. The **operator** supplies both `maker` and `recipient`; the `dpmw` signs them as given and constrains neither. |
| 7   | **Address creation precedes DPM registration.** The `dpmw` mints the address; the operator sends it to Plaee; Plaee persists it in the DPM database.                                                                                           |
| 8   | **Phase 1 is Turnkey-only.** The self-custody (mnemonic) vault is deferred behind the same `KeyVault` interface.                                                                                                                               |
| 9   | The `dpmw` is **balance-agnostic**: no balance reads, no chain monitoring, no validation. It signs agnostically.                                                                                                                               |
| 10  | The **operational wallet is not a** `dpmw` **concept.** It is a Plaee shared-balance concern; to the `dpmw` it is just another user wallet.                                                                                                    |
| 11  | Outbound calls to `relayer-api` authenticate with `X-Builder-Api-Key` only. The app-level `X-API-Key` is Plaee's own proxy credential and is never used by the `dpmw`.                                                                         |


---



## 4. Roles and responsibilities

Roles and request routing between customer, Plaee, operator gateway, and the DPM Wallet


| Entity                      | Owns                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Plaee / Plaee DPM**       | The CLOB and matching engine, on-chain settlement, market/CTF operations, `recipientId` generation, event streaming, and the `relayer-api` that broadcasts meta-transactions.                                      |
| **Operator DPM Gateway**    | Orchestration middleware. The only caller into the `dpmw`. Enforces its own API key with Plaee, applies business rules (trade holds, balance updates), and routes signed payloads from the `dpmw` onward to Plaee. |
| **DPM Wallet (**`dpmw`**)** | Address lifecycle and signing. Delegates key custody to Turnkey and holds no key material. Nothing else.                                                                                                           |


The `dpmw`'s world is deliberately small: it receives a request from the gateway, does key work or signing, and returns an artefact to the gateway.

> **Balances, ledger, and event streaming are not** `dpmw` **concerns.** Balance tracking, on-chain deposit/withdrawal monitoring, per-customer positions/fills, and order/trade event streaming are owned by **Plaee / PlaeeOS** and the operator (see the responsibility matrix in the product PDF). The operator sends trading activity to Plaee directly; the `dpmw` only signs, and signs agnostically — it never inspects a balance before producing a signature.

---



## 5. Trust boundary and outbound dependencies

The container is designed to have **near-zero egress to Plaee**. Everything the `dpmw` needs to build a signature is either supplied in the request or configured as an environment variable:

- Contract addresses (`collateral`, `ctf`, `ctfExchange`, `proxyFactory`, `relayHub`), chain ID, and the exchange address all come from **config**, replacing what would otherwise be a `GET /contract-info` call.
- The one unavoidable network read is `GET /relay-payload` on `relayer-api`, which returns the **relayer admin address** and the **RelayHub nonce** for a given EOA. These cannot be known ahead of time (the nonce is stateful and lives in the DPM `users` table), so they must be fetched at signing time.

Trust boundary: the DPM Wallet's only outbound Plaee dependency is the read-only relay-payload call

`GET /relay-payload` is registered above `relayer-api`'s authenticated route group, so it needs neither a JWT nor the `poly_*` builder HMAC. The `dpmw` authenticates it with the operator's **builder key** in the `X-Builder-Api-Key` header — and nothing else. The app-level `X-API-Key` (`APP_API_KEY`) is **not** used: that credential belongs to Plaee's own proxy callers, and the `dpmw` neither holds nor sends it. The header is supplied by injecting a `fetchImpl` into the SDK's `getRelayPayload` (see [Section 7.4](#74-injecting-x-builder-api-key-without-an-sdk-change)).

---



## 6. Architecture



### 6.1 Layered view

Layered view of the DPM Wallet: HTTP, service, SDK wiring, vault, data, and observability layers

A request flows top-down: the HTTP layer validates and authenticates, a service orchestrates the steps, the SDK wiring produces the signature via the vault, and the data layer records what happened.

### 6.2 The `KeyVault` port

`KeyVault` is the single seam every custody mode implements. No service code above it knows where a key lives. **Phase 1 ships exactly one implementation,** `TurnkeyKeyVault`; the union below is left open so a `MnemonicKeyVault` can be added later without touching any caller.

```ts
export type VaultMode = "turnkey"; // phase 2 widens this to "turnkey" | "mnemonic"

export interface VaultAccount {
  address: Address;
  index: number;
  /** Operator-supplied opaque reference (e.g. customer id). */
  ref: string;
}

export interface VaultHealth {
  mode: VaultMode;
  initialized: boolean;
  /** For turnkey: reachability of the TEE. */
  ready: boolean;
}

export interface KeyVault {
  readonly mode: VaultMode;

  /** Derive/create the account at `index`, tagging it with `ref`. Idempotent per index. */
  createAccount(index: number, ref: string): Promise<VaultAccount>;

  /** EIP-712 typed-data signature (orders). */
  signTypedData(address: Address, typedData: TypedDataDefinition): Promise<Hex>;

  /** EIP-191 personal_sign (meta-tx struct hash, cancel messages). */
  personalSign(address: Address, message: Hex | string): Promise<Hex>;

  health(): Promise<VaultHealth>;
}
```

Every signing method takes an `address` and uses it to select the correct key out of many — this is what lets one process drive thousands of wallets.

### 6.3 The derivation model

The `dpmw` recognises **one** kind of wallet. Addresses are Turnkey wallet accounts at the BIP-44 path `m/44'/60'/0'/0/{index}`, with `index` starting at `0` and allocated in creation order via `POST /v1/addresses`. Each wallet is one EOA mapping 1:1 to a proxy wallet.

**Every wallet is equal.** The set covers end customers *and* any operator-owned wallet — including the address Plaee treats as the **operational wallet** for shared balance, and whichever wallet the operator funds the others from. That distinction lives entirely on the Plaee/operator side: the operator creates each wallet with its own `ref`, and the `dpmw` stores, derives, and signs for it identically. There is no role column, no reserved index, and no special-casing anywhere in this service.

When an operator wants per-user policy isolation, the alternative is a Turnkey **sub-organisation per wallet**; this is documented as a configuration variant, not the default.

### 6.4 Proxy wallet address derivation

A wallet's on-chain proxy address is a deterministic function of its EOA, so the `dpmw` returns it at creation time with **no chain call**:

```
salt        = keccak256(abi.encodePacked(eoaAddress))       // 20-byte address, packed
initCodeHash = keccak256(minimalProxyCloneBytecode(implementation))
proxyAddress = CREATE2(proxyFactory, salt, initCodeHash)     // last 20 bytes
```

This mirrors `ProxyWalletFactory` in the `proxy-factories` repo (salt is `keccak256(abi.encodePacked(msgSender))`). The `dpmw` computes it locally with viem, using the `proxyFactory` and implementation addresses from config.

### 6.5 Custody mode (phase 1: Turnkey)

Phase 1 implements one mode. The `dpmw` holds **no private key material at all** — only the operator's Turnkey API credentials, which authorise it to *request* signatures.

- On first run, ensure a Turnkey **sub-organisation** and its HD wallet exist; create if absent. The wallet is created empty — no account is derived until one is asked for.
- `createAccount(index, ref)` calls Turnkey to create the wallet account at the derivation path and returns its address.
- Signing calls Turnkey's sign APIs (`signRawPayload` / typed-data equivalent) using `TURNKEY_API_PUBLIC_KEY` / `TURNKEY_API_PRIVATE_KEY` / `TURNKEY_ORGANIZATION_ID`.
- Turnkey is reached through a `SignerProvider` abstraction (see [Section 8](#8-third-party-integrations)) so a different signer (Fireblocks, Qredo) can replace it.

Because no key is held locally, there is no keystore, no passphrase, and no encrypted-export endpoint in phase 1. The self-custody (mnemonic) mode that would introduce them is deferred to [Section 13](#13-deferred-capabilities).

The vault must reproduce the SDK's `personalSign` hex/UTF-8 branching exactly (see [Section 9.5](#95-a-required-personalsign-detail)).

### 6.6 Every address is vault-managed

There is no externally custodied address. Every wallet the `dpmw` records is an account of its own HD wallet, which is what lets it sign for anything in the directory without a capability check at the call site.

An operator who custodies funds elsewhere — Fireblocks, Qredo, MetaMask, hardware — simply does not register that address here. It is then an unmanaged address like any other: the `dpmw` will name it as the recipient of a proxy withdrawal, and anything it has to sign for itself is executed through that custodian.

---



## 7. dpm-sdk integration and required changes

The `dpmw` reuses `dpm-sdk` for all cryptography. The SDK's meta-transaction functions are already **stateless** and take the signer as a parameter, so one process can drive many addresses without per-address SDK instances. Two things block direct reuse: those functions end by POSTing to `/submit`, and the primitives they use are not exported. The following changes are required in `dpm-sdk`. All are backwards compatible.

### 7.1 Split "build" from "submit" in `meta-tx.ts`

Today each function fetches the relay payload, encodes calls, hashes, signs, **and POSTs**:

```24:94:/home/yohoshua/Projects/dpm-sdk/src/relayer/meta-tx.ts
export async function submitUsdcCtfAllowance(params: {
  wallet: InternalWalletPort;
  relayerBaseUrl: string;
  contractInfo: ContractInfo;
  proxyWallet: string;
  fetchImpl?: FetchLike;
  requestAuth?: RequestAuth;
}): Promise<{ transactionID: string; state: string }> {
  // ... getRelayPayload → encode calls → createProxyStructHash → personalSign ...
  return submitTransaction(/* ... */);
}
```

Extract a build-only variant for each, returning the `SubmitTransactionRequest` it currently POSTs, and reduce each `submitX()` to a two-line wrapper:


| New build-only function           | Backs `dpmw` endpoint        |
| --------------------------------- | ---------------------------- |
| `buildUsdcCtfAllowanceTx(params)` | `POST /v1/meta-tx/allowance` |
| `buildRedeemPositionsTx(params)`  | `POST /v1/meta-tx/redeem`    |
| `buildFundWithdrawTx(params)`     | `POST /v1/meta-tx/withdraw`  |
| `buildSplitPositionTx(params)`    | `POST /v1/meta-tx/split`     |
| `buildMergePositionsTx(params)`   | `POST /v1/meta-tx/merge`     |


```ts
// after refactor — existing behaviour preserved
export async function submitUsdcCtfAllowance(params) {
  const body = await buildUsdcCtfAllowanceTx(params);
  return submitTransaction(body, params.relayerBaseUrl, params.fetchImpl, params.requestAuth);
}
```

`prediction-ui` and any other current caller are unaffected because the `submitX()` signatures and return types do not change.

### 7.2 Export a pure order typed-data builder

Order signing lives in `submitOrder`, which builds the order, signs it, **and POSTs to** `/order`. The `signOrder` helper and the `ORDER_EIP712_TYPES` typed-data assembly are module-private:

```228:247:/home/yohoshua/Projects/dpm-sdk/src/clob/clob-order.ts
async function signOrder(
  wallet: InternalWalletPort,
  makerSigner: string,
  chainId: number,
  exchangeAddress: string,
  order: OrderFields,
): Promise<string> {
  const typedData = {
    types: ORDER_EIP712_TYPES,
    domain: {
      name: "Polymarket CTF Exchange",
      version: "1",
      chainId,
      verifyingContract: exchangeAddress,
    },
    primaryType: "Order",
    message: orderMessage(order),
  };
  return wallet.signTypedDataV4(makerSigner, JSON.stringify(typedData));
}
```

Add and export a **pure** `buildOrderTypedData(order, chainId, exchangeAddress, domainName)` that returns the typed-data object without signing or network I/O, alongside the already-public `buildOrderFields`. The `dpmw` then builds the fields, gets the typed data, and signs through the vault.

### 7.3 Change the EIP-712 domain name

Change `"Polymarket CTF Exchange"` to `"DPM CTF Exchange"` (line 238 above), ideally exposed as a parameter/config value rather than a literal so both the SDK and the `dpmw` read it from one place. Until this lands, an order signed by `dpm-sdk` and an order signed by the `dpmw` produce **different digests** for identical inputs — one of them will be rejected by the exchange. The `dpmw` keeps the name in config with `"DPM CTF Exchange"` as the default and runs a **startup self-check** (see [Section 9.2](#92-order-eip-712-worked-example-and-self-check)).

### 7.4 Injecting `X-Builder-Api-Key` without an SDK change

Calls from the `dpmw` to `relayer-api` carry the operator's **builder key** in `X-Builder-Api-Key` — the credential `relayer-api` resolves through `builderauth` — and nothing else. The app-level `X-API-Key` is Plaee's own proxy credential; the `dpmw` neither holds nor sends it.

`RequestAuth` currently supports only `jwt`, `lp`, and `none`, but no SDK change is needed: `getRelayPayload` already accepts a `fetchImpl`, so the `dpmw` injects a fetch wrapper that adds the header.

```ts
const builderKeyFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("X-Builder-Api-Key", config.relayerBuilderApiKey);
  return fetch(input, { ...init, headers });
};
// passed as fetchImpl into buildUsdcCtfAllowanceTx(...) etc.
```

Optionally, `dpm-sdk` may add `{ mode: "builderApiKey"; apiKey: string }` to `RequestAuth` for tidiness. This is a nice-to-have, not a requirement.

### 7.5 Widen the export surface (server-only entry)

The `dpmw` needs `InternalWalletPort`, the new `buildX` functions, the `proxy-encoding` primitives, `buildOrderFields` / `buildOrderTypedData`, and `getRelayPayload`. These should be exported from a **new server-only subpath entry** (e.g. `@inabit-com/dpm-sdk/server`). The root `.` entry re-exports the Privy and Magic facades, which would drag `@privy-io/react-auth` and React into a Node container. The existing `./lp` entry is already documented as server-side and is an acceptable fallback if a new entry is not added.

### 7.6 Minor: argument-order inconsistency

Worth noting for whoever implements the adapter: `InternalWalletPort.signTypedDataV4(address, json)` takes the address first, while `personalSign(message, address)` takes it second. The adapter must not transpose them.

```5:9:/home/yohoshua/Projects/dpm-sdk/src/internal/wallet-port.ts
export interface InternalWalletPort {
  getEoaAddress(): Promise<string>;
  signTypedDataV4(address: string, typedDataJson: string): Promise<string>;
  personalSign(message: string, address: string): Promise<string>;
}
```



### 7.7 The `VaultWalletAdapter`

The SDK's `InternalWalletPort` models a **single** connected wallet (its `getEoaAddress()` takes no argument; the EOA implementation ignores the `address` parameter). The `dpmw`'s `KeyVault` is **multi-wallet**. A thin adapter binds one address per request and bridges the two:

```ts
class VaultWalletAdapter implements InternalWalletPort {
  constructor(private vault: KeyVault, private address: Address) {}

  getEoaAddress = async () => this.address;

  signTypedDataV4 = (address: string, json: string) =>
    this.vault.signTypedData(address as Address, JSON.parse(json));

  personalSign = (message: string, address: string) =>
    this.vault.personalSign(address as Address, message);
}
```

A meta-transaction request then reads:

```ts
const wallet = await walletRepo.findByCustomerRef(req.body.customerRef);
const port = new VaultWalletAdapter(keyVault, wallet.eoaAddress);
const body = await buildUsdcCtfAllowanceTx({
  wallet: port,
  relayerBaseUrl: config.relayerBaseUrl,
  contractInfo: config.contractInfo,
  proxyWallet: wallet.proxyAddress,
  fetchImpl: builderKeyFetch,
});
res.json(body); // operator POSTs this to relayer-api /submit
```

---



## 8. Third-party integrations



### 8.1 `relayer-api` (the only Plaee dependency)

- **Call:** `GET /relay-payload?address=<eoa>&type=PROXY`
- **Returns:** `{ address: <relayerAdminAddress>, nonce: <string> }`
- **Auth:** `X-Builder-Api-Key` only — the operator's builder key. The app-level `X-API-Key` is not sent (it is Plaee's proxy credential), and no JWT or `poly_`* HMAC is involved.
- **Constraint:** `type` must be `PROXY`; `SAFE` is rejected by the endpoint.
- **Precondition:** the EOA must already be registered in the DPM `users` table, because the nonce is resolved from it (see [Section 11](#11-onboarding-sequence)).

Reached through the SDK's `getRelayPayload` with the `builderKeyFetch` wrapper.

### 8.2 Signer provider abstraction (Turnkey, swappable)

Turnkey is hidden behind a `SignerProvider` interface consumed by `TurnkeyKeyVault`. Swapping providers means writing one class and changing one line of DI wiring.

```ts
export interface SignerProvider {
  readonly name: string;
  ensureWallet(): Promise<{ organizationId: string }>;
  createAccount(derivationPath: string, ref: string): Promise<{ address: Address }>;
  signRawPayload(address: Address, payload: Hex, encoding: "eip191" | "eip712" | "tx"): Promise<Hex>;
  health(): Promise<{ ready: boolean }>;
}

// Turnkey today:
class TurnkeySignerProvider implements SignerProvider { /* ... */ }

// Swap illustration — no service code changes:
class FireblocksSignerProvider implements SignerProvider { /* ... */ }
```



### 8.3 Chain client (viem)

viem is used **only** for cryptography and ABI encoding (CREATE2 derivation, `encodeFunctionData`, typed-data hashing, transaction serialisation). **No JSON-RPC provider is configured at all** — the `dpmw` neither broadcasts nor reads chain state, including balances. There is no RPC URL in the configuration, which makes balance-agnosticism a structural property rather than a convention.

---



## 9. Signing reference

Every signing operation below names the `dpm-sdk` function that owns it, so there is exactly one implementation of each.

### 9.1 EIP-712 order — field order and domain

The signed `Order` has 13 fields in this exact sequence (reordering or omitting one yields a signature the exchange rejects):


| #   | Field           | Type      |
| --- | --------------- | --------- |
| 0   | `salt`          | `uint256` |
| 1   | `maker`         | `address` |
| 2   | `signer`        | `address` |
| 3   | `taker`         | `address` |
| 4   | `recipient`     | `address` |
| 5   | `tokenId`       | `uint256` |
| 6   | `makerAmount`   | `uint256` |
| 7   | `takerAmount`   | `uint256` |
| 8   | `expiration`    | `uint256` |
| 9   | `nonce`         | `uint256` |
| 10  | `feeRateBps`    | `uint256` |
| 11  | `side`          | `uint8`   |
| 12  | `signatureType` | `uint8`   |


Domain:

```json
{
  "name": "DPM CTF Exchange",
  "version": "1",
  "chainId": 137,
  "verifyingContract": "<ctfExchange address>"
}
```

**The operator supplies** `maker` **and** `recipient`**; the** `dpmw` **supplies** `signer`**.** The request names a wallet `ref`, which selects the key that produces the signature — that key's EOA becomes `signer`. Everything about where value comes from and goes to is the operator's decision:

- `maker` — **operator-supplied**, the source of funds. For a standard user order this is the wallet's proxy address, which the `dpmw` returned at address creation, but the `dpmw` does not derive or override it.
- `recipient` — **operator-supplied and optional** (see below).
- `taker` — zero address for a public order.
- `signatureType` — `1` (`POLY_PROXY`).

**Recipient is optional.** When it is omitted — or supplied as the zero address — the exchange resolves `recipient == address(0) ? maker : recipient`, so proceeds go to the **maker**. The `dpmw` encodes an omitted recipient as the zero address in the signed order (the two are equivalent on-chain), so an unset recipient always means "pay the maker".

**No recipient constraint.** The `dpmw` does not validate `recipient` (or `maker`) against its address directory or against any notion of an operational wallet. It signs the values it is given. Deciding which addresses may receive proceeds is the operator's responsibility, enforced in the operator gateway where the business context lives — the `dpmw` has neither that context nor any balance view with which to second-guess it.

Owned by: `buildOrderFields` + the new `buildOrderTypedData` in `clob-order.ts`; signed via `KeyVault.signTypedData`.

### 9.2 Order EIP-712 — worked example and self-check

Amounts are 6-decimal micro-units. For a BUY of 100 shares at price 0.40 with `feeRateBps = 200`:

```
priceMicro       = 400000
sharesMicro      = 100000000
collateralMicro  = priceMicro * sharesMicro / 1_000_000 = 40000000
makerAmount (BUY) = collateralMicro = 40000000
takerAmount (BUY) = sharesMicro     = 100000000
```

The resulting order fields:

```json
{
  "salt": "<random uint256>",
  "maker": "<operator-supplied, typically the wallet's proxy address>",
  "signer": "<eoa of the requested ref>",
  "taker": "0x0000000000000000000000000000000000000000",
  "recipient": "<operator-supplied, or zero to pay the maker>",
  "tokenId": "<CTF token id>",
  "makerAmount": "40000000",
  "takerAmount": "100000000",
  "expiration": "0",
  "nonce": "0",
  "feeRateBps": "200",
  "side": 0,
  "signatureType": 1
}
```

**Startup self-check:** at boot the `dpmw` recomputes the digest of a fixed known order with the configured domain name and compares it to a pinned expected value. A mismatch (e.g. domain name still `"Polymarket CTF Exchange"`) fails startup loudly, rather than silently producing orders the exchange rejects at runtime.

### 9.3 Proxy meta-transaction — the `rlx:` struct hash

Allowance, redeem, withdrawal, split, and merge are **not** EIP-712. They are GSN/RelayHub meta-transactions. The signed digest is:

```
keccak256(
  "rlx:" ++ from ++ to ++ data ++
  pad32(txFee) ++ pad32(gasPrice) ++ pad32(gasLimit) ++ pad32(nonce) ++
  relayHub ++ relay
)
```

signed with `personalSign` (EIP-191) by the customer's EOA. `from` = EOA, `to` = proxy factory, `data` = ABI-encoded `proxy(ProxyCall[])`, `nonce` and `relay` come from `GET /relay-payload`.

Owned by: `createProxyStructHash` in `proxy-encoding.ts`; the encoded calls come from `encodeApproveCalldata`, `encodeSetApprovalForAllCalldata`, `encodeRedeemPositionsCalldata`, `encodeTransferCalldata`, `encodeSplitPositionCalldata`, `encodeMergePositionsCalldata`, wrapped by `encodeProxyCall` / `encodeProxyTransactionData`.

### 9.4 Meta-transaction — worked example (allowance)

`buildUsdcCtfAllowanceTx` produces three proxy calls in one batch:

1. `USDC.approve(ctf, maxUint256)` — for split/mint
2. `USDC.approve(ctfExchange, maxUint256)` — for BUY orders
3. `CTF.setApprovalForAll(ctfExchange, true)` — for SELL orders/transfers

and returns a complete `SubmitTransactionRequest` the operator POSTs verbatim to `relayer-api`:

```json
{
  "from": "<eoa>",
  "to": "<proxyFactory>",
  "proxyWallet": "<proxyWallet>",
  "data": "0x<encoded proxy(calls)>",
  "nonce": "<from relay-payload>",
  "signature": "0x<personal_sign of rlx: hash>",
  "signatureParams": {
    "gasPrice": "0",
    "gasLimit": "300000",
    "relayerFee": "0",
    "relayHub": "<relayHub>",
    "relay": "<relayer admin address>"
  },
  "type": "PROXY",
  "metadata": "approve USDC + setApprovalForAll CTF exchange"
}
```



### 9.5 A required `personalSign` detail

The SDK's EOA `personalSign` branches on the message shape: a `0x`-prefixed hex string is signed as **raw bytes**, anything else as **UTF-8**:

```29:37:/home/yohoshua/Projects/dpm-sdk/src/internal/eoa-wallet.ts
    async personalSign(message: string, _address: string) {
      // Relayer meta-tx passes a 0x-prefixed struct hash; attestation / cancel
      // pass plain UTF-8. Match Magic's personal_sign behavior.
      if (message.startsWith("0x") && /^0x[0-9a-fA-F]+$/.test(message)) {
        return account.signMessage({ message: { raw: message as Hex } });
      }
      return account.signMessage({ message });
    },
```

`TurnkeyKeyVault` — and any `KeyVault` added later — **must reproduce this branch exactly**. The `rlx:` struct hash is hex and must be signed as raw bytes; a cancel message is UTF-8. Getting this wrong computes the signature over the wrong preimage and the RelayHub rejects it.

### 9.6 Cancel message

Order cancellation uses EIP-191 `personal_sign` of the plaintext:

```
Cancel order: <orderHash> on market: <marketId>
```

Owned by: `formatCancelOrderMessage` in `clob-order.ts`; the `dpmw` converts to hex with viem's `toHex` before signing (matching provider behaviour), then returns the signature.

---



## 10. HTTP API

Base path: `/v1`. All requests require the inbound `X-API-Key` header carrying `DPMW_API_KEY` ([Section 12](#12-security)) — this is the operator gateway's key *into* the `dpmw`, unrelated to the builder key the `dpmw` sends *out* to `relayer-api` (§7.4). All bodies are validated by the app-wide `ValidationPipe` against the controllers' DTOs; a validation failure returns `400` with the error envelope. All responses are JSON. An OpenAPI description of everything below is generated from those DTOs and served at `/v1/docs`.

### 10.1 Error envelope

```json
{ "error": { "code": "STRING_CODE", "message": "human readable", "details": {} } }
```


| Code                      | HTTP | Meaning                                                                                                                            |
| ------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED`            | 401  | Missing/invalid API key.                                                                                                           |
| `VALIDATION_FAILED`       | 400  | Request body or query failed DTO validation.                                                                                       |
| `VAULT_NOT_INITIALIZED`   | 409  | Sub-organisation not yet created.                                                                                                  |
| `ADDRESS_NOT_FOUND`       | 404  | Unknown customer ref / address.                                                                                                    |
| `CUSTOMER_NOT_REGISTERED` | 409  | EOA not yet registered with DPM; relay-payload unavailable.                                                                        |
| `RELAYER_UNAVAILABLE`     | 502  | `GET /relay-payload` failed.                                                                                                       |
| `SIGNING_FAILED`          | 500  | Vault/provider signing error.                                                                                                      |
| `IDEMPOTENCY_CONFLICT`    | 409  | Same idempotency key, different body.                                                                                              |




### 10.2 Vault


| Method | Path               | Purpose                                                                        |
| ------ | ------------------ | ------------------------------------------------------------------------------ |
| `GET`  | `/v1/health`       | Liveness + vault health. Public (no key), per prediction-gateway convention.   |
| `POST` | `/v1/vault/init`   | First-run: establish the Turnkey sub-organisation and its HD wallet. Idempotent. |
| `GET`  | `/v1/vault/status` | `{ mode, initialized, subOrgName? }`.                                          |


There is no export endpoint in phase 1: Turnkey holds the key material, so the `dpmw` has nothing to export. Backup of key material is a Turnkey concern.

`POST /v1/vault/init` response:

```json
{ "mode": "turnkey", "initialized": true, "subOrgName": "dpm-builder-42-acme-9f2c1ab4e0d7" }
```

No address is derived here. The HD wallet arrives empty and every account is minted on demand by `POST /v1/addresses`.



### 10.3 Addresses


| Method | Path                 | Purpose                                                   |
| ------ | -------------------- | --------------------------------------------------------- |
| `POST` | `/v1/addresses`      | Create the next user wallet; returns EOA + derived proxy. |
| `GET`  | `/v1/addresses`      | List addresses (paginated).                               |
| `GET`  | `/v1/addresses/:ref` | Look up one address by ref.                               |


`POST /v1/addresses` request:

```json
{ "ref": "customer-12345" }
```

Response:

```json
{ "ref": "customer-12345", "index": 0, "address": "0x<eoa>", "proxyAddress": "0x<proxy>" }
```

Every address is created here, at the next free index, and they are all the same kind of thing. An operator who needs a wallet for Plaee's shared balance (the "operational wallet"), or one to fund the others from, creates it through this call like any other, under a `ref` of its choosing — the `dpmw` treats it identically.

### 10.4 Order signing


| Method | Path              | Purpose                                         |
| ------ | ----------------- | ----------------------------------------------- |
| `POST` | `/v1/sign/order`  | Build + sign an order; return the signed order. |
| `POST` | `/v1/sign/cancel` | Sign a cancel message for an existing order.    |


`POST /v1/sign/order` request:

```json
{
  "ref": "customer-12345",
  "maker": "0x<operator-supplied source of funds>",
  "side": 0,
  "tokenId": "71321045…",
  "shares": 100,
  "price": 0.40,
  "feeRateBps": 200,
  "recipient": "0x<operator-supplied, optional>"
}
```

Response:

```json
{
  "order": { "salt": "…", "maker": "0x…", "signer": "0x…", "taker": "0x0…0",
             "recipient": "0x…", "tokenId": "…", "makerAmount": "40000000",
             "takerAmount": "100000000", "expiration": "0", "nonce": "0",
             "feeRateBps": "200", "side": 0, "signatureType": 1 },
  "signature": "0x…",
  "orderHash": "0x…"
}
```

The operator forwards this to PlaeeOS. The `dpmw` does not call `clob-api`.

`ref` selects the signing key and becomes `signer`. `maker` and `recipient` are the operator's to decide and are signed as supplied — neither is validated against the address directory, and no balance is consulted. `recipient` is **optional**: omit it (or pass the zero address) to have the exchange pay the maker (see [Section 9.1](#91-eip-712-order--field-order-and-domain)).

### 10.5 Meta-transactions (return a submit-ready body)


| Method | Path                    | Backing SDK function      |
| ------ | ----------------------- | ------------------------- |
| `POST` | `/v1/meta-tx/allowance` | `buildUsdcCtfAllowanceTx` |
| `POST` | `/v1/meta-tx/redeem`    | `buildRedeemPositionsTx`  |
| `POST` | `/v1/meta-tx/withdraw`  | `buildFundWithdrawTx`     |
| `POST` | `/v1/meta-tx/split`     | `buildSplitPositionTx`    |
| `POST` | `/v1/meta-tx/merge`     | `buildMergePositionsTx`   |


Common request shape:

```json
{ "ref": "customer-12345", "conditionId": "0x…", "amountDecimal": "10.0", "recipient": "0x…" }
```

(`conditionId` for redeem/split/merge; `recipient` + `amountDecimal` for withdraw; allowance needs only `ref`.) Every response is a complete `SubmitTransactionRequest` (see [Section 9.4](#94-meta-transaction--worked-example-allowance)). The operator supplies `recipient` and `amountDecimal`; the `dpmw` signs them without checking the destination or whether the proxy holds the amount. Each of these endpoints requires the wallet's EOA to be DPM-registered; otherwise `CUSTOMER_NOT_REGISTERED`.

### 10.6 Audit


| Method | Path        | Purpose                                                       |
| ------ | ----------- | ------------------------------------------------------------- |
| `GET`  | `/v1/audit` | Query the audit trail (paginated, filter by ref/action/time). |




### 10.8 Idempotency

All `POST` signing and address-creation endpoints accept an `Idempotency-Key` header. The `dpmw` stores the key with a hash of the request body and the response; a replay with the same key and body returns the stored response, and the same key with a different body returns `IDEMPOTENCY_CONFLICT`. Address creation is additionally idempotent by derivation index.

---



## 11. Onboarding sequence

Address creation and DPM registration have a strict order, because `GET /relay-payload` resolves the nonce from the DPM `users` table. A customer EOA that Plaee has never seen cannot yield a relay payload, so no meta-transaction can be signed for it until registration completes.

Onboarding sequence: address creation precedes DPM registration before any meta-transaction can be signed

This is a hard precondition on every meta-transaction endpoint, surfaced as the distinct `CUSTOMER_NOT_REGISTERED` error so the operator can tell "not yet registered with Plaee" apart from a genuine signing failure.

---



## 12. Security



### 12.1 Inbound authentication

- Every `/v1` route except `/v1/health` requires `X-API-Key`, compared in constant time against `DPMW_API_KEY`. This is the operator back-office authentication called for in the product requirements.



### 12.2 Outbound credential handling

- The builder key sent to `relayer-api` (`RELAYER_BUILDER_API_KEY`) and the Turnkey credentials are read from env and never logged.
- No key material is held: Turnkey holds every private key, so there is no keystore and no passphrase to protect.



### 12.3 What is not policed

The `dpmw` enforces no movement policy at all. It does **not** validate order `maker`/`recipient`, does **not** restrict where a wallet's funds may move, and does **not** check that any address holds what is being signed for. Those are business rules that depend on ledger state and shared balance, and they belong in the operator gateway — the `dpmw` has neither the context nor a balance view to enforce them.

Authorisation stops at the API key: a caller that holds it may ask for any signature the service offers, for any `ref` in the directory.

### 12.4 Log redaction

Structured logs (one JSON object per line, matching the prediction-gateway convention) redact: Turnkey API credentials, API keys (inbound `DPMW_API_KEY` and outbound builder key alike), HMAC secrets, and full signatures (logged as a truncated prefix). Addresses, indices, refs, and non-secret request metadata are logged in full for support.

---



## 13. Deferred capabilities

One capability is deferred to a later phase, and it needs no new interface because the seam already exists.

**Self-custody (mnemonic) vault.** A `MnemonicKeyVault` implementing the existing `KeyVault` port ([Section 6.2](#62-the-keyvault-port)) — BIP-39 mnemonic generated on first run, addresses derived at `m/44'/60'/0'/0/{index}`, the mnemonic encrypted at rest with AES-256-GCM under a scrypt-derived passphrase, and a guarded encrypted-export endpoint for operator backup. Adding it means widening `VaultMode`, writing one class, and changing one line of DI wiring; no service, route, or repository code above the port changes. The `vault_state` table gains the keystore columns at that point ([Section 14.1](#141-tables)).

Everything else once considered for a later phase is now **out of scope permanently**, not stubbed:

- **On-chain monitoring, balance tracking, and confirmation watching.** The `dpmw` is balance-agnostic by design (§2.3). No `ChainMonitor` interface is defined, and no RPC provider is configured, precisely so this cannot creep in. Plaee and the operator own it.
- **Per-customer trading ledger** and **order/trade/position event streaming** — owned by Plaee / PlaeeOS, see the note in [Section 4](#4-roles-and-responsibilities).

---



## 14. Data model (Postgres)

**Postgres** via **TypeORM** over the `pg` connection pool. One database, migrated by an explicit deploy step.

### 14.1 Tables

`vault_state` — one row; the vault's initialisation state. It holds **no key material**: Turnkey does.


| Column             | Type       | Notes                                     |
| ------------------ | ---------- | ----------------------------------------- |
| `id`               | INTEGER PK | Always `1`.                               |
| `mode`             | TEXT       | `turnkey` (the only value in phase 1).    |
| `initialized`      | INTEGER    | 0/1.                                      |
| `turnkey_org_id`   | TEXT       | Turnkey organisation / sub-org id.        |
| `created_at`       | TEXT       | RFC3339.                                  |


A later mnemonic vault ([Section 13](#13-deferred-capabilities)) adds `keystore_ciphertext`, `keystore_salt`, and `keystore_iv` in its own migration; they are deliberately absent now so nothing suggests the container stores keys.

`wallets` — the address directory.


| Column               | Type           | Notes                                                   |
| -------------------- | -------------- | ------------------------------------------------------- |
| `id`                 | INTEGER PK     |                                                         |
| `ref`                | TEXT UNIQUE    | Operator-supplied wallet reference.                     |
| `derivation_index`   | INTEGER UNIQUE | BIP-44 index.                                           |
| `eoa_address`        | TEXT UNIQUE    | Lowercased hex.                                         |
| `proxy_address`      | TEXT           | Lowercased hex; derived.                                |
| `turnkey_account_id` | TEXT           | Turnkey account id.                                     |
| `dpm_registered`     | INTEGER        | 0/1; set when the operator confirms Plaee registration. |
| `created_at`         | TEXT           |                                                         |


Indices: `wallets_ref`, `wallets_eoa_lower`, `wallets_proxy_lower`, `wallets_index`.

`signing_requests` — every signing action, for audit and idempotency linkage.


| Column           | Type    | Notes                                 |
| ---------------- | ------- | ------------------------------------- |
| `id`             | TEXT PK | UUID.                                 |
| `ref`            | TEXT    | FK-ish to `wallets.ref`.              |
| `kind`           | TEXT    | `order`                               |
| `request_hash`   | TEXT    | keccak256 of the canonical request.   |
| `result_summary` | TEXT    | orderHash / txId prefix (no secrets). |
| `status`         | TEXT    | `ok`                                  |
| `created_at`     | TEXT    |                                       |


`audit_events` — human-facing event log for support.


| Column       | Type       | Notes                                                  |
| ------------ | ---------- | ------------------------------------------------------ |
| `id`         | INTEGER PK |                                                        |
| `ref`        | TEXT       | Nullable.                                              |
| `action`     | TEXT       | e.g. `address.create`, `sign.order`, `meta.allowance`. |
| `outcome`    | TEXT       | `success`                                              |
| `detail`     | TEXT       | Redacted JSON.                                         |
| `created_at` | TEXT       |                                                        |


`idempotency_keys`


| Column          | Type    | Notes                   |
| --------------- | ------- | ----------------------- |
| `key`           | TEXT PK | From `Idempotency-Key`. |
| `request_hash`  | TEXT    | keccak256 of the body.  |
| `response_json` | TEXT    | Stored response.        |
| `created_at`    | TEXT    | TTL-eligible.           |




### 14.2 Migrations

TypeORM migrations live in `src/db/migrations/` as reversible classes, listed in that folder's `index.ts` rather than discovered by a glob, and are applied by a step separate from the service, never from within its boot logic. Under compose — the development and production stacks alike — it is a one-shot `migrate` service running `dist/db/migrate-cli` from the service's own image, which the service waits on with `service_completed_successfully`; in a bare `docker run` it is the image's `CMD`, which migrates and then hands the process to the service; outside a container, the operator runs `npm run db:migrate`. Keeping it in the command rather than in application code leaves it visible in the logs and overridable — the service can be started without it, and the migration run without the service. Boot asserts the schema is present and fails with the command to run if it is not. `synchronize` is off in every environment, so the schema only ever changes by an applied migration.

### 14.3 Durability across container restarts

**Yes — SQLite is durable in Docker, provided the database file lives on a mounted volume rather than the container's writable layer.** The container filesystem is discarded when the container is removed; the volume is not. With `DATABASE_PATH=/data/dpmw.sqlite` and `/data` backed by the named volume `dpmw-data`, the database survives `docker stop`/`start`, `docker restart`, `docker rm` + re-create, and image rebuilds or version upgrades. It is destroyed only by an explicit `docker volume rm dpmw-data` or a `docker compose down -v` (note the `-v`).

Four rules make this safe in practice:


| Rule                                                                                                      | Why                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mount the directory, never the file.** Bind-mount `/data`, not `/data/dpmw.sqlite`.                     | WAL mode writes two sidecar files next to the database — `dpmw.sqlite-wal` and `dpmw.sqlite-shm`. They must sit on the same filesystem as the main file, and SQLite recovery may recreate them. A single-file bind mount breaks both.                                                                     |
| **Local disk only — no NFS/SMB/network volumes.**                                                         | SQLite relies on POSIX advisory locking, which is unreliable over network filesystems and can silently corrupt the database.                                                                                                                                                                              |
| **Exactly one writer.** Never run more than one `dpmw` container against the same volume (`replicas: 1`). | SQLite permits one writer at a time; two containers sharing a volume will produce lock contention and, on a network mount, corruption.                                                                                                                                                                    |
| `PRAGMA synchronous=FULL`.                                                                                | In WAL mode the SQLite default is `NORMAL`, which fsyncs only at checkpoint — a host crash or power loss can lose the most recently committed transactions. For a wallet directory, losing a just-created address record means losing track of customer funds, so the write-latency cost is worth paying. |


Connection pragmas set in `src/db/client.ts` at open:

```ts
db.pragma("journal_mode = WAL");   // concurrent reads during writes; crash-safe
db.pragma("synchronous = FULL");   // fsync every commit — no lost address rows
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");  // wait rather than throw SQLITE_BUSY
```

**Crash safety.** A `docker kill`, OOM kill, or host power loss leaves a populated `-wal` file; SQLite replays it automatically on the next open, so every committed transaction is present and no partial transaction is. No manual repair step is needed.

**Graceful shutdown.** On `SIGTERM` (what `docker stop` sends, forwarded by `tini`), the process stops accepting new requests, lets in-flight ones finish, then closes the database — which runs a final WAL checkpoint and folds the `-wal` contents back into the main file. This is not required for correctness, but it means the volume holds a single self-contained file, which makes backups and restores simpler.

Because the `dpmw` is sign-only, there is **no in-flight state to recover**. Signing is deterministic and holds nothing across requests; RelayHub nonces are fetched from `relayer-api` at signing time rather than stored. A crash mid-request loses at most that one response, and the caller can safely retry with the same `Idempotency-Key`.

---



## 15. Project structure

A flat, `tsc`-built ESM service in the style of prediction-gateway, with viem-based crypto in the style of dpm-sdk.

```
dpm-wallet/
├── docs/
│   └── TECHNICAL-SPEC.md
├── src/
│   ├── main.ts                  # entry: create the Nest app, mount docs, listen
│   ├── app.module.ts            # composition root + app-scoped guard/interceptor/filter/pipe
│   ├── app.setup.ts             # global prefix, body cap, x-powered-by (shared with e2e tests)
│   ├── config.ts                # env → typed Config (manual parse + validation)
│   ├── config.module.ts         # provides CONFIG and ENCRYPTION_KEY
│   ├── database.module.ts       # opens the volume, exports the repositories
│   ├── tokens.ts                # injection tokens for the non-class collaborators
│   ├── common/
│   │   ├── decorators/public.decorator.ts     # exempts a route from the API-key guard
│   │   ├── guards/api-key.guard.ts            # X-API-Key, applied app-wide
│   │   ├── guards/vault-initialized.guard.ts
│   │   ├── interceptors/idempotency.interceptor.ts
│   │   ├── filters/all-exceptions.filter.ts   # error envelope
│   │   ├── pipes/ref.pipe.ts
│   │   ├── dto/pagination.dto.ts
│   │   └── validation/                        # class-validator decorators + pipe policy
│   ├── addresses/               # controller + service + dto
│   ├── sign/                    # order + cancel
│   ├── meta-tx/
│   ├── audit/
│   ├── health/
│   ├── vault/
│   │   ├── vault.module.ts      # custody seam; global, exports KEY_VAULT
│   │   ├── vault.controller.ts  # init + status
│   │   ├── vault.service.ts     # init, status, cold-start rehydration
│   │   ├── key-vault.interface.ts  # KeyVault port + types
│   │   ├── turnkey-vault.ts     # the only vault in phase 1; uses SignerProvider
│   │   └── providers/
│   │       ├── signer-provider.interface.ts
│   │       └── turnkey.provider.ts
│   ├── sdk/
│   │   ├── vault-wallet-adapter.ts  # InternalWalletPort bridge
│   │   ├── builder-key-fetch.ts     # fetchImpl injecting X-Builder-Api-Key
│   │   └── wiring.ts                # picks SDK build functions
│   ├── db/
│   │   ├── client.ts            # TypeORM DataSource over the pg pool
│   │   ├── data-source.ts       # the same options, for the TypeORM CLI
│   │   ├── entities/
│   │   ├── repositories/
│   │   └── migrations/
│   ├── crypto/
│   │   └── proxy-address.ts     # CREATE2 derivation (viem)
│   ├── observability/
│   │   ├── log.ts               # JSON console logging + redaction
│   │   └── audit.ts
│   └── startup/
│       ├── startup.service.ts   # boot hook: self-check, rehydrate, purge idempotency keys
│       ├── self-check.ts        # EIP-712 domain digest check
│       └── shutdown.ts          # SIGTERM: drain, close app, WAL checkpoint
├── vendor/
│   └── dpm-sdk/                 # git submodule (built in the image)
├── test/                        # end-to-end specs (app, vault lifecycle, cold start)
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── nest-cli.json
├── jest.config.js
├── tsconfig.json
├── package.json
└── README.md
```



### 15.1 Stack choices


| Concern         | Choice                                      | Rationale                                                                      |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| Runtime         | Node ≥ 22                                   | Matches the workspace's `engines.node >= 20`; 22 for current LTS.              |
| Language/module | TypeScript 6, CommonJS, `nest build`        | The module format the Nest ecosystem and Jest assume, resolved with `bundler` so viem's ESM-only declarations are readable from CommonJS — see `tsconfig.json`. TypeScript stays on 6 until 7.1: 7.0 ships `tsc` without the programmatic compiler API that the Nest CLI and ts-jest both call. |
| HTTP            | NestJS 11 on Express                        | Matches the platform's other Nest services.                                    |
| Validation      | class-validator + class-transformer         | Nest's own DTO pipeline, driven by the app-wide `ValidationPipe`.              |
| API docs        | `@nestjs/swagger`                           | Served at `/v1/docs`, generated from the controllers and DTOs.                 |
| Crypto/ABI      | viem v2                                     | Matches dpm-sdk; reused via the vendored SDK.                                  |
| DB              | Postgres + `pg` + TypeORM                   | Matches the platform's other services; TypeORM gives reversible migrations generated from the entities. |
| Tests           | Jest + supertest                            | Nest's default; `@nestjs/testing` boots the real module graph.                 |
| Logging         | JSON to stdout                              | Matches prediction-gateway `log.ts`.                                           |




### 15.2 Vendoring dpm-sdk

`dpm-sdk` is added as a git submodule under `vendor/dpm-sdk` and referenced as a path/workspace dependency. The Docker build compiles it before the app so the required changes ([Section 7](#7-dpm-sdk-integration-and-required-changes)) and the app ship as one coordinated build with no npm release in between. The app imports from the SDK's server-only entry (or `./lp` as fallback) to avoid pulling React/Privy/Magic into the container.

---



## 16. Configuration

All configuration is via environment variables, parsed and validated at boot (missing required values throw before the server binds).


| Variable                  | Required      | Default             | Description                                                                             |
| ------------------------- | ------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `PORT`                    | no            | `8090`              | HTTP listen port.                                                                       |
| `DPMW_VAULT_MODE`         | no            | `turnkey`           | `turnkey` is the only accepted value in phase 1.                                        |
| `DPMW_API_KEY`            | yes           | —                   | Inbound `X-API-Key` expected from the operator gateway.                                 |
| `TURNKEY_API_PUBLIC_KEY`  | yes           | —                   | Turnkey API public key.                                                                 |
| `TURNKEY_API_PRIVATE_KEY` | yes           | —                   | Turnkey API private key.                                                                |
| `TURNKEY_ORGANIZATION_ID` | yes           | —                   | Turnkey organisation/sub-org id.                                                        |
| `RELAYER_BASE_URL`        | yes           | —                   | Base URL of `relayer-api` (for `/relay-payload`).                                       |
| `RELAYER_BUILDER_API_KEY` | yes           | —                   | Builder key sent as `X-Builder-Api-Key` to `relayer-api`. No app `X-API-Key` is used.   |
| `CHAIN_ID`                | yes           | `137`               | Polygon mainnet. Used for EIP-712 domain and tx serialisation only — there is no RPC.   |
| `EXCHANGE_DOMAIN_NAME`    | yes           | `DPM CTF Exchange`  | EIP-712 order domain name; self-checked at boot.                                        |
| `CONTRACT_COLLATERAL`     | yes           | —                   | USDC address.                                                                           |
| `CONTRACT_CTF`            | yes           | —                   | ConditionalTokens address.                                                              |
| `CONTRACT_CTF_EXCHANGE`   | yes           | —                   | CTF Exchange (`verifyingContract`).                                                     |
| `CONTRACT_PROXY_FACTORY`  | yes           | —                   | ProxyWalletFactory address.                                                             |
| `CONTRACT_PROXY_IMPL`     | yes           | —                   | Proxy implementation (for CREATE2 derivation).                                          |
| `CONTRACT_RELAY_HUB`      | yes           | —                   | RelayHub address.                                                                       |
| `DATABASE_PATH`           | no            | `/data/dpmw.sqlite` | SQLite file on the mounted volume.                                                      |
| `LOG_LEVEL`               | no            | `info`              | `debug` | `info` | `warn` | `error`.                                                    |


The six `CONTRACT_*` values plus `CHAIN_ID` are exactly what a `GET /contract-info` call would return; supplying them as config removes that outbound dependency.

Turnkey credentials are unconditionally required because Turnkey is the only vault in phase 1. There is no keystore passphrase (nothing is stored locally), no RPC URL (no chain reads), and no operational-wallet address (not a `dpmw` concept).

---



## 17. Docker and operations



### 17.1 Image

Multi-stage Alpine build (Node 22), building the vendored SDK first, running as a non-root user, with `better-sqlite3` compiled against the runtime.

```dockerfile
# ---- build ----
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++   # better-sqlite3 native build
WORKDIR /app
COPY vendor/dpm-sdk ./vendor/dpm-sdk
RUN cd vendor/dpm-sdk && npm ci && npm run build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/vendor/dpm-sdk/dist ./vendor/dpm-sdk/dist
COPY --from=build /app/dist ./dist
RUN addgroup -S dpmw && adduser -S dpmw -G dpmw && mkdir -p /data && chown dpmw:dpmw /data
USER dpmw
VOLUME ["/data"]
EXPOSE 8090
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
```

> Native-module caveat: `better-sqlite3` compiles a native addon. Building and running on the **same** Node major/Alpine base (as above) avoids ABI mismatches; a prebuilt binary is used when available.



### 17.2 Compose (operator convenience)

```yaml
services:
  dpmw:
    build: .
    ports: ["8090:8090"]
    env_file: .env
    # Named volume holding dpmw.sqlite plus its -wal/-shm sidecars.
    # Mount the directory, not the file, and keep it on local disk (§14.3).
    volumes: ["dpmw-data:/data"]
    restart: unless-stopped
    stop_grace_period: 30s   # let in-flight signs finish and the WAL checkpoint
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8090/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3
volumes:
  dpmw-data:      # survives `down`; destroyed only by `down -v`
```

> Do not scale this service beyond one replica — SQLite allows a single writer per database file (§14.3).



### 17.3 Health and readiness

- `GET /v1/health` (liveness) returns `200` with `{ status: "ok" }` once the process is up.
- Readiness additionally checks vault health: Turnkey is reachable and the DB is writable. Not ready until `POST /v1/vault/init` has run at least once.



### 17.4 First-run

1. Operator sets env (Turnkey credentials and contract addresses).
2. The container starts: its command applies the schema, then the service boots and passes the EIP-712 self-check.
3. Operator calls `POST /v1/vault/init` → a Turnkey sub-organisation and an empty HD wallet are created. No address yet.
4. Wallet onboarding proceeds per [Section 11](#11-onboarding-sequence). If the operator needs a wallet to back Plaee's shared balance, it is created through the same `POST /v1/addresses` call as any other — there is no separate step and no reserved index.



### 17.5 Restart and cold-start recovery

On every subsequent boot the container rebuilds its entire working state from the volume. **Nothing is held only in memory between runs**, and no step requires the operator to re-supply anything except the environment variables (crucially the Turnkey credentials, which are never written to disk).

Cold-start recovery: the container rebuilds vault and directory state from the SQLite volume, failing fast on any mismatch

`StartupService.onApplicationBootstrap` runs this sequence before the HTTP server binds, after Nest has constructed every provider:

```ts
export async function bootstrap(config: Config): Promise<Runtime> {
  const db = openDatabase(config.databasePath);   // pragmas from §14.3
  assertSchemaPresent(db);                        // migrating is a deploy step, not a boot step

  const state = await vaultStateRepo.load(db);
  if (!state?.initialized) return uninitialized(db); // only /v1/health + /v1/vault/init

  const vault = await rehydrateVault(state, config);  // re-authenticate against Turnkey
  await assertVaultMatchesDirectory(vault, db);       // re-read accounts and compare addresses
  await assertExchangeDomain(config);                 // existing EIP-712 self-check

  const nextIndex = await walletRepo.maxDerivationIndex(db) + 1;
  await idempotencyRepo.purgeExpired(db);
  return ready({ db, vault, nextIndex });
}
```

What each step recovers:


| Step                      | Recovered from                     | Notes                                                                                                                                     |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Migrations**            | `src/db/migrations/`               | Idempotent; brings an older volume up to the current schema after an image upgrade. Applied by an explicit deploy step, never at boot.    |
| **Vault state**           | `vault_state` (single row)         | Mode and Turnkey org id.                                                                                                                  |
| **Signing keys**          | Nothing — they never left Turnkey  | The container re-reads `turnkey_org_id` and re-authenticates with the env credentials. There is no key material on the volume to recover. |
| **Address directory**     | `wallets`                          | Refs, derivation indices, EOA and proxy addresses, Turnkey account ids, `dpm_registered` flags.                                           |
| **Next derivation index** | `MAX(derivation_index) + 1`        | Read from the database, never from memory or config, so a restart can never reissue an index and collide with an existing address.        |
| **Idempotency window**    | `idempotency_keys`                 | Survives restart, so a client retrying across a restart still gets the original response instead of a second signature.                   |
| **Audit history**         | `audit_events`, `signing_requests` | Continuous across restarts; the log is append-only.                                                                                       |


Two of these steps are **fail-fast consistency checks** rather than loads, and the container refuses to become ready if either fails:

- `assertVaultMatchesDirectory` re-reads the stored wallets' accounts from Turnkey and compares the returned addresses against `wallets.eoa_address`. A mismatch means the volume and the Turnkey organisation have diverged — a database restored from a different install, or the container pointed at a different `TURNKEY_ORGANIZATION_ID`. Continuing would silently mint a second, unrelated address tree for existing refs, so this aborts startup with `VAULT_DB_MISMATCH` and exits non-zero (a boot failure, not an HTTP error — the server never binds).
- Wrong or revoked Turnkey credentials fail earlier and unambiguously: re-authentication fails in `rehydrateVault`, so the container never reaches the address checks.

Readiness (§17.3) only reports ready after `bootstrap` completes, so an orchestrator will not route traffic to a container whose vault could not be rehydrated.

### 17.6 Backup and restore

The volume is the unit of backup. Because the database may have an active `-wal` file, **do not** `cp` **the** `.sqlite` **file from a running container** — that can capture a torn state. Use SQLite's online backup, which is safe against a live writer and produces a single consistent file:

```bash
docker exec dpmw node -e "require('better-sqlite3')(process.env.DATABASE_PATH)\
  .exec(\"VACUUM INTO '/data/backup-\$(date +%F).sqlite'\")"
```

Restore is the reverse: stop the container, place the file at `DATABASE_PATH` on the volume (removing any stale `-wal`/`-shm` sidecars), and start. The backup contains **no key material** — only the address directory, audit trail, and vault state — so it must be restored against the same Turnkey organisation it was taken from, or `assertVaultMatchesDirectory` (§17.5) will refuse to start. Key backup and recovery are Turnkey's responsibility, not the volume's.

---



## 18. Open items for implementation

- Confirm the Turnkey signing API surface for EIP-712 typed data vs raw payloads, and map it onto `SignerProvider.signRawPayload`.
- Pin `GET /relay-payload` authentication with a contract test: the deployed `relayer-api` must accept a bare `X-Builder-Api-Key` on that route, with no app `X-API-Key` present. The global API-key gate in front of the route group has to admit builder keys for this to hold.
- Confirm the exact `SubmitTransactionRequest` field set accepted by the deployed `relayer-api` matches the SDK's `SubmitTransactionRequest` type (they align today; pin it with a contract test).
- Decide whether `EXCHANGE_DOMAIN_NAME` becomes an SDK parameter (preferred) or stays a `dpmw`-side override until the SDK change lands.
- Decide whether externally custodied addresses should later be representable through the `SignerProvider` seam (e.g. a Fireblocks provider that assembles and signs on their behalf). v1 supports vault-managed addresses only.

