# dpm-wallet

Operator-hosted address management and signing service for DPM prediction markets.

Each operator runs this container inside their own infrastructure. It holds the keys for their
customers' wallets, derives the on-chain addresses those keys control, and signs the artefacts the
operator's backend needs — CLOB orders, cancellations, proxy meta-transactions, and treasury
transfers. It returns signed bytes and nothing else.

Two properties shape the whole design:

- **Sign-only.** Nothing is broadcast and nothing is submitted. The operator routes signed
  artefacts onward to the DPM platform or to the chain.
- **Balance-agnostic.** There is no RPC provider, no chain watcher, and no balance table. The
  service never checks that a wallet can afford what it is signing for. Whether a signed artefact
  is economically valid is the operator's concern.

See `docs/TECHNICAL-SPEC.md` for the full design. Deviations from it are listed under
[Spec deviations](#spec-deviations).

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Default listen port: **8090**. Then initialise the vault once:

```bash
curl -XPOST localhost:8090/v1/vault/init -H 'X-API-Key: <DPM_WALLET_API_KEY>'
```

`@inabit-com/dpm-sdk` comes from the public npm registry, pinned to an exact version. This service
imports only its `/server` entry point, which carries the signing and encoding primitives and no
browser wallet code. When the SDK gains a change this service needs, publish it and bump the pin
here — there is no local linking step.

## API

Every route sits under `/v1` and requires `X-API-Key: $DPM_WALLET_API_KEY`, except `GET /v1/health`.
`POST` routes accept an optional `Idempotency-Key`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Liveness; the only unauthenticated route |
| `POST` | `/v1/vault/init` | First-run Turnkey sub-organization and master wallet setup; idempotent |
| `GET` | `/v1/vault/status` | Vault mode and master wallet info |
| `POST` | `/v1/addresses` | Mint a user wallet at the next free index |
| `GET` | `/v1/addresses` | Paginated directory |
| `GET` | `/v1/addresses/:ref` | One wallet by ref |
| `POST` | `/v1/addresses/:ref/dpm-attestation` | Sign the proof of control the DPM registration call needs |
| `POST` | `/v1/addresses/:ref/dpm-registered` | Mark the EOA as registered with DPM |
| `POST` | `/v1/sign/order` | EIP-712 CLOB order signature |
| `POST` | `/v1/sign/cancel` | EIP-191 cancellation signature |
| `POST` | `/v1/meta-tx/allowance` | Approve USDC + CTF for the exchange |
| `POST` | `/v1/meta-tx/redeem` | Redeem resolved positions |
| `POST` | `/v1/meta-tx/split` | Split collateral into outcome tokens |
| `POST` | `/v1/meta-tx/merge` | Merge outcome tokens back to collateral |
| `POST` | `/v1/meta-tx/withdraw` | Withdraw collateral from the proxy |
| `POST` | `/v1/treasury/fund-proxy` | Signed USDC transfer from the master to a user's proxy |
| `POST` | `/v1/treasury/external-withdraw` | Signed transfer from the master to an unmanaged address |
| `POST` | `/v1/treasury/sweep` | Signed transfer of a stray balance from a user's EOA to the master |
| `GET` | `/v1/audit` | Query the audit trail |

### Errors

Failures return `{ "error": { "code", "message", "details"? } }`. The `code` is part of the API
contract — the gateway is expected to branch on it, since the same HTTP status covers several
distinct situations.

| Code | Status | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or wrong `X-API-Key` |
| `VALIDATION_FAILED` | 400 | Request body or query failed schema validation |
| `VAULT_NOT_INITIALIZED` | 409 | Call `POST /v1/vault/init` first |
| `ADDRESS_NOT_FOUND` | 404 | No wallet for that ref |
| `REF_ALREADY_EXISTS` | 409 | That ref already has an address; refs are not reusable |
| `CUSTOMER_NOT_REGISTERED` | 409 | The EOA is not in the DPM `users` table yet — retry after registering |
| `IDEMPOTENCY_CONFLICT` | 409 | Same `Idempotency-Key` replayed with a different body |
| `POLICY_VIOLATION` | 403 | A treasury rule refused the request |
| `RELAYER_REQUEST_FAILED` | 502 | `GET /relay-payload` did not succeed; the cause is upstream and unknown here |
| `SIGNING_FAILED` | 500 | The custody backend refused or errored |
| `INTERNAL_ERROR` | 500 | Unexpected; the underlying message is withheld |

## How it works

### Addresses

A wallet is identified by an operator-chosen `ref`, which maps to a BIP-44 derivation index. Index
0 is the master; user wallets start at 1. The index is allocated from `MAX(derivation_index)` in
SQLite rather than from memory, so a restart can never reissue one and hand two customers the same
address.

Each wallet has two addresses. The **EOA** is what the key controls and what signs. The **proxy**
is the CREATE2 clone the EOA owns, which holds the funds and is the `maker` on an order. The proxy
address is computed locally from the factory, implementation, and EOA — no chain call — by
replicating the factory's 167-byte creation code byte-for-byte. `src/crypto/proxy-address.test.ts`
cross-checks it against the canonical Go implementation.

### Registering an address with the DPM platform

A new address can be signed for immediately but cannot trade: `GET /relay-payload` resolves the
RelayHub nonce from the DPM `users` table, so the platform has to know the EOA first. This service
never talks to the platform on the operator's behalf — it only signs — and the operator reaches
the platform through `prediction-gateway`, never a backend service directly.

| Step | Call |
|---|---|
| 1. Mint the address | `POST /v1/addresses` `{ ref }` |
| 2. Prove control of it | `POST /v1/addresses/:ref/dpm-attestation` → `{ address, signature }` |
| 3. Register it | `POST /api/prediction/gamma/custody/users` with `X-Builder-Api-Private-Key` and the pair from step 2 |
| 4. Record that it is registered | `POST /v1/addresses/:ref/dpm-registered` |
| 5. Approve the exchange | `POST /v1/meta-tx/allowance` `{ ref }`, then relay the returned body |

The attestation is an EIP-191 signature over the SDK's `LP_ATTESTATION_MESSAGE`, the same fixed
string the LP onboarding path uses. It carries no address of its own: `gamma-api` recovers the
signer and registers whatever address that yields, which is what makes it proof rather than a
claim. Step 3 is idempotent per address, so a lost response can be retried.

Step 5 needs no separate proxy deployment. `ProxyWalletFactory.proxy()` deploys the CREATE2 clone
on its first relayed call, which is the allowance batch.

### Signing

Orders are signed as EIP-712 typed data against the exchange domain. The typed-data layout comes
	status, body := postCustodyUser(t, s
from `dpm-sdk` rather than being restated here, because a field present in one copy and missing
from the other yields a valid signature over the wrong digest — no error, just an order that can
never settle. The domain name is the SDK's `EXCHANGE_DOMAIN_NAME` constant and is not
configurable; startup checks it against a pinned golden digest, so an SDK upgrade that renamed it
fails the boot instead of silently producing rejected orders.

An omitted `recipient` is signed as the zero address, which `Trading._deriveRecipient` reads as
"pay the maker".

Meta-transactions are GSN RelayHub calls. `dpm-sdk` builds the proxy call batch and the RelayHub
struct hash; this service signs that hash as an EIP-191 personal message and returns a body the
operator can `POST` to `relayer-api` verbatim.

### Where the money is, and which endpoint moves it

Every treasury rule follows from one fact: a managed EOA is a signing key, not a balance.

| Wallet | Balance lives in | Its EOA holds |
|---|---|---|
| Master (index 0) | its own EOA | the treasury |
| User (index ≥ 1) | its CREATE2 proxy | nothing, by design |

That leaves exactly three raw-transaction movements, and each endpoint names only the far end
because the near end is fixed:

| Movement | Endpoint | Signed by |
|---|---|---|
| Master → a user's proxy (USDC) | `POST /v1/treasury/fund-proxy` `{ to: <ref> }` | master |
| Master → an unmanaged address (USDC or POL) | `POST /v1/treasury/external-withdraw` `{ destination }` | master |
| A user's EOA → master (USDC or POL) | `POST /v1/treasury/sweep` `{ from: <ref> }` | that user |

There is deliberately no way to express "master pays a managed EOA". An external withdrawal to an
address in the directory is refused with `POLICY_VIOLATION` for the same reason.

The fourth movement — a user's proxy back to the master — is not a raw transaction at all. Only
the RelayHub can spend from a proxy, so it goes through `POST /v1/meta-tx/withdraw` with the
master's EOA as the recipient.

The sweep exists only to recover assets someone sent to a signing key by mistake. Nothing credits
a user EOA on purpose.

Treasury transfers are ordinary EIP-1559 transactions. Since there is no RPC here, the operator
supplies `nonce`, `gasLimit`, `maxFeePerGas`, and `maxPriorityFeePerGas`.

**Proxy wallets cannot hold the native token.** The proxy is an EIP-1167 clone of a `ProxyWallet`
that declares no payable fallback, so a plain POL transfer to one reverts. This is why funding is
USDC-only rather than asset-selectable. User wallets never need POL regardless: their transactions
are relayed and the relayer pays the gas.

### Key custody

`KeyVault` is the port every signing path goes through; `TurnkeyKeyVault` is the phase-1
implementation. All digest construction — EIP-712 hashing, EIP-191 prefixing, transaction
serialisation — happens here, and only the final 32-byte digest crosses into the custody backend.
That keeps the domain logic testable and makes a second provider a matter of implementing
`SignerProvider`.

The master wallet is always the vault's own account at index 0. An externally custodied master is
not supported: every wallet this service knows about is one it can sign for.

#### Its own Turnkey sub-organization

This install holds no parent-organization credential. On first initialization it generates a P-256
API key pair, asks `dpm-api` for a Turnkey sub-organization whose only root-user credential is that
public key, and keeps the pair on its volume — the private half encrypted with
`DPM_WALLET_ENCRYPTION_KEY`. From then on it talks to Turnkey directly, and the credential it holds
can act on nothing but its own sub-organization. Only `dpm-api` can create one, which is why that
call exists at all.

Neither half of the key pair signs anything on-chain: they authorise API requests. The secp256k1
keys behind every address never leave the TEE.

`dpm-api` creates the sub-organization, its HD wallet, and the master account at index 0 in a
single Turnkey activity, and returns all three identifiers. There is no window in which a
sub-organization exists without the address its owner operates from, and initialization itself
never calls Turnkey: one `dpm-api` request is the whole flow.

`POST /v1/vault/init` is idempotent by short-circuit rather than by upsert — once the state row
says initialised it returns what is already there and writes nothing, so re-running it cannot
append a second master row or a second audit event. On a first run it writes in two phases: the key
pair first, then everything `dpm-api` reported, in one SQLite transaction. That order is what
makes a crash recoverable. `dpm-api` recognises a retry by the public key it receives, so an
attempt that died after the first phase resumes with the *same* key pair and is handed the
sub-organization it already owns; a freshly generated pair would be refused as a second
sub-organization for the same owner and the install could never initialise.

The `vault_state` row makes exactly one transition, guarded on `initialized = 0`. It identifies
which sub-organization and which master the volume belongs to; overwriting it would silently
repoint an install at a different key tree and orphan every address already issued.

### Cold start

All state lives in one SQLite file on a mounted volume: the sub-organization credentials, the vault
handle, the address directory, the audit trail, and idempotency records. On boot the service
decrypts its Turnkey credentials, reloads the vault handle, and reconciles the directory against
the custody backend in both directions:

- An address the directory issued that the vault does **not** hold aborts the boot. The operator
  has been handed that address and may have funded it, and no key exists to sign for it.
- An address the vault holds that the directory does not is logged and tolerated. It is the
  expected residue of a crash between deriving an account and inserting its row — recoverable,
  since account creation is idempotent per derivation path. Failing the boot on it would let one
  badly-timed crash brick the service permanently.

Mount the **directory**, not the file: SQLite's WAL mode writes `-wal` and `-shm` siblings.

Migrations are tracked, not replayed. Drizzle records each applied migration's hash in
`__drizzle_migrations` and runs only what is missing, so boot against an existing volume applies
just the new files. The service does this itself at startup; the `db:*` scripts below are for
authoring migrations and for inspecting a volume by hand.

## Configuration

`.env.example` documents every variable. The ones worth calling out:

| Variable | Notes |
|---|---|
| `DPM_WALLET_API_KEY` | Inbound credential the operator gateway presents as `X-API-Key` |
| `DPM_WALLET_ENCRYPTION_KEY` | AES-256 key (64 hex chars) for the Turnkey API private key kept on the volume. Losing it loses access to the sub-organization |
| `DATABASE_PATH` | Inside the mounted directory; defaults to `/data/dpm-wallet.sqlite` |
| `DPM_API_BASE_URL` | Where the sub-organization is created, on first initialization only |
| `RELAYER_BUILDER_API_KEY` | Sent as `X-Builder-Api-Private-Key`; the app-level `X-API-Key` is the DPM platform's own credential and is never sent from here. It also identifies a builder-owned install to `dpm-api` |
| `DPM_LP_API_KEY` | Set instead on a liquidity-provider install, which has no builder secret |
| `CONTRACT_*` | What a `GET /contract-info` call would return, supplied as config to remove that outbound dependency |

The EIP-712 exchange domain name is deliberately absent: it is fixed by the deployed exchange and
owned by the SDK. So are Turnkey credentials — this install mints its own on first initialization
rather than being handed any.

## Development

```bash
npm test              # vitest
npm run typecheck
npm run db:generate   # write a new SQL migration after editing src/db/schema.ts
npm run db:migrate    # apply whatever a database is missing; the service does this at boot
npm run db:check      # verify the migration folder is consistent
npm run db:studio     # browse the database
```

The three commands that touch a database read `DRIZZLE_DATABASE_PATH`, defaulting to
`./data/dpm-wallet.sqlite`, because the container's `/data` path is not reachable from a
workstation. Point it at a copy of a volume rather than a live one.

Tests boot the real app over an ephemeral port against an in-memory database and a local signer
that derives the same BIP-44 tree Turnkey would. Signatures are therefore real and recoverable, so
tests assert what was actually signed rather than that a call was made.

## Deployment

```bash
docker compose up --build
```

The image is a multi-stage Alpine build running as a non-root user. `better-sqlite3` publishes
prebuilt binaries for glibc only, so on Alpine's musl its native addon is always compiled from
source; the build stage carries the toolchain, prunes dev dependencies in place, and hands the
runtime stage a `node_modules` that already contains the compiled addon. The runtime image ships
no compiler. Mount a volume at the parent directory of `DATABASE_PATH`.

`SIGTERM` stops accepting connections, lets in-flight requests finish, and checkpoints the
database before exit.

## Spec deviations

These differ from `docs/TECHNICAL-SPEC.md`, recorded here because the spec is the review artefact:

1. **`POST /v1/addresses/:ref/dpm-registered` is new.** The spec describes the
   `wallets.dpm_registered` column without giving the operator a way to set it. Meta-transaction
   signing gates on the flag, so the gateway needs this call after the DPM platform confirms
   registration. `POST /v1/addresses/:ref/dpm-attestation` is new for the step before it: the
   registration call has to prove control of the address, and the key that proves it never leaves
   here.
2. **Outbound auth uses `X-Builder-Api-Private-Key`, not `X-Builder-Api-Key`.** The latter is a
   publishable key safe to ship to a browser and cannot authenticate a backend. `relayer-api`
   gained a private-key credential (`builder_api_private_keys`) for this caller.
3. **Treasury endpoints require chain parameters in the request.** The spec implies the service
   resolves the nonce and gas itself, which it cannot: configuring an RPC provider is exactly what
   §2.3 rules out to keep the service balance-agnostic.
4. **No externally custodied master.** The spec allows one; this service does not. Every wallet it
   records is one it holds a key for.
5. **No external-withdrawal allowlist or dual control.** The spec gates external withdrawals on
   both. The only rule here is that the master is the sole wallet that can reach an address
   outside the directory, which follows from where the funds sit rather than from a configured
   policy.
6. **No `signing_requests` table.** The spec has it alongside `audit_events`, but it was a
   partially populated second copy of the same trail with no reader. Every signing action now
   records exactly one `audit_events` row, written by the service that performs it.
7. **`rebalance` is split into `fund-proxy` and `sweep`.** The spec has one endpoint that moves
   value between the master and any wallet in the directory, which would let the master credit a
   managed EOA. Managed EOAs are signing keys and hold nothing, so the two legitimate directions
   became separate endpoints that each name only their far end.
8. **Turnkey credentials are earned at initialization, not configured.** The spec supplies
   `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY` and `TURNKEY_API_PRIVATE_KEY` as
   environment variables, which means every install is handed a credential for an organisation it
   shares. Instead each install mints its own P-256 key pair on first initialization and `dpm-api`
   creates a Turnkey sub-organization governed by it, so a leaked credential reaches one install's
   keys and no others. `DPM_WALLET_ENCRYPTION_KEY` replaces them, encrypting the private half on
   the volume.
