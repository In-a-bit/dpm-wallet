# dpm-wallet

Operator-hosted address management and signing service for DPM prediction markets.

Each operator runs this container inside their own infrastructure. It holds the keys for their
customers' wallets, derives the on-chain addresses those keys control, and signs the artefacts the
operator's backend needs — CLOB orders, cancellations, and proxy meta-transactions. It returns
signed bytes and nothing else.

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
docker compose up -d postgres   # the database; nothing runs without it
npm run db:migrate              # apply the schema
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
| `POST` | `/v1/vault/init` | First-run Turnkey sub-organization setup; idempotent |
| `GET` | `/v1/vault/status` | Vault mode and sub-organization name |
| `POST` | `/v1/addresses` | Mint a wallet at the next free index |
| `GET` | `/v1/addresses` | Paginated directory |
| `GET` | `/v1/addresses/:ref` | One wallet by ref |
| `POST` | `/v1/addresses/:ref/dpm-attestation` | Sign the proof of control the DPM registration call needs |
| `POST` | `/v1/addresses/:ref/dpm-registered` | Mark the EOA as registered with DPM |
| `POST` | `/v1/sign/order` | EIP-712 CLOB order signature |
| `POST` | `/v1/sign/cancel` | EIP-191 cancellation signature |
| `POST` | `/v1/meta-tx/allowance` | Approve USDC + CTF for the exchange |
| `POST` | `/v1/meta-tx/redeem` | Redeem resolved positions, optionally forwarding the payout to a recipient |
| `POST` | `/v1/meta-tx/split` | Split collateral into outcome tokens |
| `POST` | `/v1/meta-tx/merge` | Merge outcome tokens back to collateral |
| `POST` | `/v1/meta-tx/withdraw` | Withdraw collateral from the proxy |
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
| `RELAYER_REQUEST_FAILED` | 502 | `GET /relay-payload` did not succeed; the cause is upstream and unknown here |
| `SIGNING_FAILED` | 500 | The custody backend refused or errored |
| `INTERNAL_ERROR` | 500 | Unexpected; the underlying message is withheld |

## How it works

### Addresses

A wallet is identified by an operator-chosen `ref`, which maps to a BIP-44 derivation index
starting at 0. The index is allocated from `MAX(derivation_index)` in the database rather than from
memory, so a restart can never reissue one and hand two customers the same address.

There is no role. Every wallet has the same capabilities, and an operator wallet backing a shared
balance is created exactly like an end customer's, under a `ref` of the operator's choosing. Which
wallet plays which part is the operator's business, and this service does not model it.

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
| 6. Relay it | `POST /api/prediction/relayer/submit` with `X-Builder-Api-Private-Key` and `X-Builder-Address: <the EOA>` |
| 7. Trade | `POST /v1/sign/order` `{ ref, maker: <the proxy>, … }`, then `POST /api/prediction/clob/order` with the same header pair |

The attestation is an EIP-191 signature over the SDK's `LP_ATTESTATION_MESSAGE`, the same fixed
string the LP onboarding path uses. It carries no address of its own: `gamma-api` recovers the
signer and registers whatever address that yields, which is what makes it proof rather than a
claim. Step 3 is idempotent per address, so a lost response can be retried.

Step 5 needs no separate proxy deployment. `ProxyWalletFactory.proxy()` deploys the CREATE2 clone
on its first relayed call, which is the allowance batch.

Steps 6 and 7 pair the builder secret key with `X-Builder-Address`, and the platform acts only if
that address is one the calling builder registered in step 3. It is the same shape as the `X-LP-*`
pair a liquidity provider sends, and it is why a custody operator needs neither the `poly_*` HMAC
headers on the relayer nor per-user L2 credentials on the CLOB: the `poly_*` secret is shared by
every caller and would let any holder name any address, and L2 credentials would have to be minted
and stored for each user separately.

### Signing

Orders are signed as EIP-712 typed data against the exchange domain. The typed-data layout comes
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

A wallet's tradable balance lives in its CREATE2 proxy. Its EOA is a signing key and holds nothing
by design, so anything that lands there arrived by mistake.

The one movement this service signs is a proxy paying out to an address, through
`POST /v1/meta-tx/withdraw`. It has to be a relayed call rather than a raw transaction, because
only the RelayHub can spend from a proxy.

Funding a proxy is a plain USDC transfer from wherever the operator keeps its float, which is not
an address this service manages. It needs no signature from here, so there is no endpoint for it.

Raw EVM transaction signing is out of scope entirely: this service signs EIP-712 orders and
EIP-191 messages, and nothing that spends from a managed EOA directly. An EOA holds nothing by
design, so in practice there is nothing there to spend.

**Proxy wallets cannot hold the native token.** The proxy is an EIP-1167 clone of a `ProxyWallet`
that declares no payable fallback, so a plain POL transfer to one reverts. A wallet never needs
POL regardless: its transactions are relayed and the relayer pays the gas.

### Key custody

`KeyVault` is the port every signing path goes through; `TurnkeyKeyVault` is the phase-1
implementation. All digest construction — EIP-712 hashing, EIP-191 prefixing — happens here, and
only the final 32-byte digest crosses into the custody backend.
That keeps the domain logic testable and makes a second provider a matter of implementing
`SignerProvider`.

Every address is an account of the vault's own HD wallet. Externally custodied addresses are not
supported: every wallet this service knows about is one it can sign for.

#### Its own Turnkey sub-organization

This install holds no parent-organization credential. On first initialization it generates a P-256
API key pair, asks `dpm-api` for a Turnkey sub-organization whose only root-user credential is that
public key, and keeps the pair on its volume — the private half encrypted with
`DPM_WALLET_ENCRYPTION_KEY`. From then on it talks to Turnkey directly, and the credential it holds
can act on nothing but its own sub-organization. Only `dpm-api` can create one, which is why that
call exists at all.

Neither half of the key pair signs anything on-chain: they authorise API requests. The secp256k1
keys behind every address never leave the TEE.

`dpm-api` creates the sub-organization and its HD wallet in a single Turnkey activity, and returns
both identifiers. The wallet arrives empty: no account is derived, because this service owns its
derivation convention and mints every address on demand. Initialization itself never calls
Turnkey — one `dpm-api` request is the whole flow.

`POST /v1/vault/init` is idempotent by short-circuit rather than by upsert — once the state row
says initialised it returns what is already there and writes nothing, so re-running it cannot
append a second audit event. On a first run it writes in two phases: the key pair first, then
everything `dpm-api` reported, in one Postgres transaction. That order is what makes a crash
recoverable. `dpm-api` recognises a retry by the public key it receives, so an attempt that died
after the first phase resumes with the *same* key pair and is handed the sub-organization it
already owns; a freshly generated pair would be refused as a second sub-organization for the same
owner and the install could never initialise.

The `vault_state` row makes exactly one transition, guarded on `initialized = false`. It identifies
which sub-organization the database belongs to; overwriting it would silently repoint an install at
a different key tree and orphan every address already issued.

### Cold start

Nearly all state lives in Postgres: the sub-organization credentials, the vault handle, the address
directory, the audit trail, and idempotency records. The one thing outside it is
`api-key-pair.plaintext.json`, an unencrypted copy of the API key pair written to `DATA_DIR` the
moment it is confirmed to be the pair `vault_state` holds — the mounted volume exists for that file
alone, so it survives a restart like everything in the database does. On boot the service
decrypts its Turnkey credentials, reloads the vault handle, and reconciles the directory against
the custody backend in both directions:

- An address the directory issued that the vault does **not** hold aborts the boot. The operator
  has been handed that address and may have funded it, and no key exists to sign for it.
- An address the vault holds that the directory does not is logged and tolerated. It is the
  expected residue of a crash between deriving an account and inserting its row — recoverable,
  since account creation is idempotent per derivation path. Failing the boot on it would let one
  badly-timed crash brick the service permanently.

Migrations are tracked, not replayed. TypeORM records each applied migration in the `migrations`
table and runs only what is missing, so running it against an existing database applies just the
new classes. Each one is reversible — `npm run db:revert` steps the last migration back down.

**Migrating is a step of its own, not something the service does to the database on its own
initiative.** Where that step lives depends on how you start it:

- **Container.** The image's `CMD` migrates and then starts the service, so `docker compose up`
  needs nothing extra. Because it is the command rather than application code, you can watch it in
  the logs and opt out — `docker compose run --rm dpm-wallet node dist/main` starts without
  touching the schema, and `… node dist/db/migrate-cli` migrates without starting.
- **`npm`.** Nothing migrates implicitly. Run `npm run db:migrate` yourself, then start the
  service.

Either way, starting against an unmigrated database refuses the boot and names the command to run,
rather than failing later on a customer's first request.

## Configuration

`.env.example` documents every variable. The ones worth calling out:

| Variable | Notes |
|---|---|
| `DPM_WALLET_API_KEY` | Inbound credential the operator gateway presents as `X-API-Key` |
| `DPM_WALLET_ENCRYPTION_KEY` | AES-256 key (64 hex chars) for the Turnkey API private key kept in the database. Losing it loses access to the sub-organization |
| `DATABASE_URL` | Postgres connection string. Required — there is no default, so an install cannot silently come up against the wrong database |
| `DATA_DIR` | The mounted directory, holding only `api-key-pair.plaintext.json`; defaults to `/data` |
| `POSTGRESQL_*` | Read by the compose `postgres` service only. The service itself uses `DATABASE_URL` |
| `DPM_API_BASE_URL` | Where the sub-organization is created, on first initialization only |
| `RELAYER_BUILDER_API_KEY` | Sent as `X-Builder-Api-Private-Key`, paired with `X-Builder-Address` naming the wallet being acted for; the app-level `X-API-Key` is the DPM platform's own credential and is never sent from here. It also identifies a builder-owned install to `dpm-api` |
| `DPM_LP_API_KEY` | Set instead on a liquidity-provider install, which has no builder secret |
| `CONTRACT_*` | What a `GET /contract-info` call would return, supplied as config to remove that outbound dependency |

The EIP-712 exchange domain name is deliberately absent: it is fixed by the deployed exchange and
owned by the SDK. So are Turnkey credentials — this install mints its own on first initialization
rather than being handed any.

## Development

Everything below needs the database running:

```bash
docker compose up -d postgres
```

```bash
npm test              # jest: unit specs and the end-to-end suite
npm run test:e2e      # the end-to-end suite alone
npm run typecheck
npm run lint
npm run db:generate -- src/db/migrations/Name
                        # diff the entities against the database and write the migration that
                        # closes the gap; add it to src/db/migrations/index.ts to arm it
npm run db:migrate      # apply whatever a database is missing (needs ts-node)
npm run db:migrate:dist # the same, from the build output — no ts-node, so it also works
                        # inside the runtime image, where the dev dependencies are gone
npm run db:revert       # step the most recently applied migration back down
npm run db:check        # list migrations and show which are applied
```

The `db:*` commands read the same `DATABASE_URL` the service does, so you cannot migrate one
database and start against another. Point it at a copy rather than a live one.

Tests boot the real app over an ephemeral port against a local signer that derives the same BIP-44
tree Turnkey would. Signatures are therefore real and recoverable, so tests assert what was
actually signed rather than that a call was made.

Each boot creates a throwaway `dpmw_test_*` database and drops it on close, so test files cannot
see each other's rows. They reach the server through `TEST_DATABASE_URL` (see `.env.example`),
defaulting to the compose `postgres` service; a suite run with nothing listening fails naming the
command above rather than passing vacuously.

## Deployment

```bash
docker compose up --build
```

This brings up Postgres, waits for it to accept connections, then builds and starts the service —
which migrates before it listens. The image is a multi-stage Alpine build running as a non-root
user, with no native addons to compile and dev dependencies pruned before the runtime stage.

Postgres is the one stateful piece. The `/data` volume holds only `api-key-pair.plaintext.json`,
and the app container itself is disposable — the single-writer constraint that used to cap this
service at one replica was SQLite's, not Postgres's.

`SIGTERM` stops accepting connections, lets in-flight requests finish, and drains the connection
pool before exit.

## Spec deviations

These differ from the design as originally specified. `docs/TECHNICAL-SPEC.md` is kept in step with
the implementation, so each decision is recorded here instead; the wording it replaced is in git.

1. **`POST /v1/addresses/:ref/dpm-registered` is new.** The spec describes the
   `wallets.dpm_registered` column without giving the operator a way to set it. Meta-transaction
   signing gates on the flag, so the gateway needs this call after the DPM platform confirms
   registration. `POST /v1/addresses/:ref/dpm-attestation` is new for the step before it: the
   registration call has to prove control of the address, and the key that proves it never leaves
   here.
2. **Outbound auth uses `X-Builder-Api-Private-Key`, not `X-Builder-Api-Key`.** The latter is a
   publishable key safe to ship to a browser and cannot authenticate a backend. The platform
   gained a private-key credential (`builder_api_private_keys`) for this caller, and both
   `relayer-api` `POST /submit` and `clob-api` `POST /order` pair that key with
   `X-Builder-Address` so a builder can only act for the addresses it registered.
3. **No treasury endpoints and no raw transaction signing.** The spec has `rebalance` and
   `external-withdraw`, both of which exist to move value out of a privileged central wallet.
   There is no such wallet here, and a managed EOA is a signing key that holds nothing, so there
   is nothing for them to move. `KeyVault` correspondingly has no `signTransaction`, and the
   external-withdrawal allowlist and dual-control gate the spec describes are gone with it.
4. **No wallet roles.** The spec gives index 0 a privileged central-treasury role, optionally held
   by an external custodian. This service has neither: every wallet is an account of its own HD
   wallet with identical capabilities, indices start at 0, and which wallet funds which is the
   operator's decision rather than a property of the directory.
5. **No `signing_requests` table.** The spec has it alongside `audit_events`, but it was a
   partially populated second copy of the same trail with no reader. Every signing action now
   records exactly one `audit_events` row, written by the service that performs it.
6. **Turnkey credentials are earned at initialization, not configured.** The spec supplies
   `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY` and `TURNKEY_API_PRIVATE_KEY` as
   environment variables, which means every install is handed a credential for an organisation it
   shares. Instead each install mints its own P-256 key pair on first initialization and `dpm-api`
   creates a Turnkey sub-organization governed by it, so a leaked credential reaches one install's
   keys and no others. `DPM_WALLET_ENCRYPTION_KEY` replaces them, encrypting the private half in
   the database.
7. **Postgres, not embedded SQLite.** The spec specifies SQLite via `better-sqlite3` on a mounted
   volume (§14), which caps the service at one replica, needs a native addon compiled against the
   runtime, and rules out network storage because it depends on POSIX advisory locking. Postgres
   removes all three: the app container becomes stateless apart from the plaintext key pair backup,
   and `DATABASE_URL` replaces `DATABASE_PATH`. The schema is otherwise the same four tables — the
   `0/1` integer flags became real booleans and the ISO-8601 `text` timestamps became `timestamptz`.
8. **TypeORM, not Drizzle.** The spec names Drizzle for the typed migrations it generates (§15.1).
   TypeORM generates them by diffing the entities against the live database and, unlike Drizzle,
   emits a `down` for each, so a bad deploy is revertible rather than only rollable-forward. The
   entities keep timestamps as ISO-8601 strings through a value transformer, so the column type
   changed without the shape the services and responses see changing with it.
