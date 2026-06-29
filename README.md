# WARRANT

**Custody an autonomous agent cannot break. Private mandate, public settlement.**

## Who this is for

Picture an **autonomous trading agent** that holds funds and moves them on its own.
You need two things at once that are normally in tension:

1. The agent must be **physically incapable** of exceeding the limits you set — per-trade
   size, total position, drawdown, and who it may pay.
2. Those limits must stay **private**. A mandate published on-chain is a map your
   competitors and front-runners read and game.

WARRANT gives you both. The principal commits a *hashed* mandate on-chain and funds a
custody contract. After that, the agent can move money **only** by producing a zero-knowledge
proof that the move obeys the mandate and extends the contract's state-root chain. There is
no other code path that releases funds: a non-compliant move can't even *produce* a proof,
and a forged or replayed proof reverts on-chain. The leash is enforced by mathematics — and
nobody, not even the agent, can see the leash.

## How it works

WARRANT is a Soroban (Stellar) contract that releases a stablecoin **only** when a
Groth16 zero-knowledge proof shows the transfer obeys a pre-committed, private
mandate — and only when the move extends an on-chain state-root chain. No valid
proof, no movement. No matching prior state, rejected. The mandate and the book
stay private; only the proof, the public commitment, and the action are on-chain.

The frontend is a **wallet-native Stellar dapp**: the user connects a real testnet
wallet (Freighter), and every on-chain action — funding the contract, settling a
compliant proof, and even the adversarial forged/replay attempts — is signed by the
wallet after explicit approval. The browser never holds a secret key.

## The token

The demonstrated asset is **USDW**, a test stablecoin issued as a Stellar Asset
Contract (SAC) on testnet for this project (7 decimals). The UI, scripts, and this
README all use USDW consistently. The contract is asset-agnostic — it custodies
whatever token it was initialized with — but the polished demo path is USDW, not
native XLM.

## The actors

- **Principal** — sets the mandate (per-transaction limit, max position, drawdown
  limit), commits its hash on-chain, funds the contract, and never reveals the mandate.
- **Agent / prover** — holds the private book and must produce a valid proof to move
  funds. It cannot move money any other way.
- **Verifier contract** — the only thing that can release funds, and only on a valid,
  state-extending proof.
- **Recipient** — receives the stablecoin when a settlement verifies.

## Curve: BLS12-381 (not BN254)

Stellar's native pairing host functions (added in Protocol 22) are **BLS12-381**.
Circom's *default* prime is BN254, but a BN254 proof cannot verify against a
BLS12-381 pairing check. So every circuit here is compiled with `circom -p bls12381`,
the powers-of-tau ceremony uses the `bls12381` curve, and the on-chain verifier calls
`env.crypto().bls12_381()`. This was confirmed directly against the on-chain verifier
and a real proving key, not assumed.

## Live oracle: Reflector (SEP-40)

The price mark can come from the **live [Reflector](https://reflector.network) oracle**, a
real decentralized price feed on Stellar. The contract's `settle_with_reflector` entrypoint
performs an on-chain **cross-contract call** to Reflector's SEP-40 `lastprice(Other(asset))`,
reads the authenticated price, and requires that exact price to be the price the Groth16 proof
was built against. No matching live price, no settlement — so the agent can only act on a
*current, real* oracle mark, and a proof built against any other price reverts on-chain.

- Reflector testnet oracle (CEX/DEX feed, base USD, 14 decimals): `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63`
- Run it: `node app/scripts/sdk/drive_reflector.mjs` (provisions fresh, reads the live XLM/USD
  price, proves bound to it, settles via the on-chain Reflector read, then shows a wrong-price
  attempt revert).

Real testnet run (XLM/USD `17764414800342` ≈ $0.1776):

| Scenario | Expected | Actual | Tx |
| --- | --- | --- | --- |
| **Compliant, priced by live Reflector** | SUCCESS | ✅ SUCCESS, 50 moved, root advanced | [`d0053bba…fc826b1a`](https://stellar.expert/explorer/testnet/tx/d0053bba25f66d36249621b30380c5845b68fdc464d823f39a65ad7ffc826b1a) |
| **Proof bound to a fabricated price** | revert | ✅ REVERTED `PriceMismatch #15` (contract re-read Reflector) | [`1c90b4de…78dea775`](https://stellar.expert/explorer/testnet/tx/1c90b4de5ed8db88044ca07555be7e83544b036cdae24c626df7e6c878dea775) |

The contract also keeps a self-signed (Ed25519) price path (`settle_with_price`) for the
deterministic, replayable UI demo, whose fixed price keeps the chained settlement sequence
reproducible. Both paths bind the same sixth public signal; only the *source* of the price
differs (live Reflector vs an admin-signed report).

## Toolchain

- circom 2.2.3 (built from source)
- snarkjs 0.7.6
- Stellar CLI 27.0.0, targeting testnet
- Rust (stable) with `wasm32v1-none` for the Soroban contract

Bootstrap all of the above (idempotent — skips whatever is already installed):

```bash
npm run setup:toolchain    # app/scripts/setup_toolchain.sh
```

## Layout

```
app/
  circuits/        circom sources
  contracts/       Soroban verifier / custody contract (Rust)
  tools/encoder/   verification-key / proof / public-input -> Soroban byte encoder
  scripts/         end-to-end run scripts
```

`circom/` and `CircomStellar/` are vendored upstream clones used during bring-up and
are intentionally excluded from version control.

## Verified testnet deployment

The deployment the UI talks to (`app/frontend/public/demo-config.json`), all on
**Stellar testnet**:

| Thing | Value |
| --- | --- |
| Warrant contract | `CA4F7XRMZVDL4WKPKJIKGJUMFPI5HBCX5OV6N5BCHEDPHWVH4SVK3NFE` |
| USDW token (SAC) | `CBJ3ZUCZMLI5VSVFNHXAIWMYETEXKDLXH7UR7ZSF5WSL5OEPNQIACIQV` |
| Recipient 0 | `GAXIYPH63NUKNMGDGTMEHW3CR7XBXB3NA4FM4B2FK35Q23JVF4I2OGLE` |
| Oracle public key (Ed25519) | `eaee897380a52a6b18205c33d79ed68e26f23ab85f46a9f74e044a989411af0b` |
| Network passphrase | `Test SDF Network ; September 2015` |
| Soroban RPC | `https://soroban-testnet.stellar.org` |
| Explorer | `https://stellar.expert/explorer/testnet` |

Live on-chain reads at the time of writing (no keys needed — see commands below):

- `policy_commitment` = `2e3da43f5d59ed1757ae427481b609988aca187b7075f43733225a7590893a87`
- `current_state_root` = `45be8d721eb60367b8485489cb4668c6690bc8571750ade6ba195e97cba264f1` (genesis)
- USDW `decimals` = 7, `symbol` = `USDW`
- contract USDW balance = `100000` raw (0.01 USDW), recipient balance = `0`

This contract is intentionally left **at genesis** so a viewer can perform the first
of **12 chained** compliant settlements live from their own wallet, then keep going.

## Evidence: chained settlements + adversarial reverts on a fresh contract

`N_SETTLE=3 node app/scripts/sdk/drive.mjs` provisions a brand-new warrant on testnet and
drives the whole sequence as real, explorer-visible transactions: **three chained compliant
settlements** (each extends the prior state root), then a forged proof and a replayed proof.
The run below is real testnet output:

- Fresh warrant: `CAAGUC2UDIDMGTIFENCMB3NFOV37DGRR56WH5SRQERQXUMY3WXZGD7MF`
- Submitter/admin: `GBUFYAOIT7MW6DXA5KFFXPZ7C3STKLRLRX4OFQNHVIYYUKYDZFFVR6O3`

| Scenario | Expected | Actual | Tx hash / proof error | Custody (raw) | Recipient (raw) | State root |
| --- | --- | --- | --- | --- | --- | --- |
| Contract initialized + funded | genesis root | OK | (init + mint) | 100000 | 0 | `45be8d72…cba264f1` |
| **Compliant settle #1** | SUCCESS, pays recipient | ✅ SUCCESS | [`462d65ef…a634f27e`](https://stellar.expert/explorer/testnet/tx/462d65efbe64fd6b8166ca8c2d3e8ad02485e548dbaee6f67eb022b0a634f27e) | 100000 → **99950** | 0 → **50** | `45be8d72…` → `2cffefaa…` |
| **Compliant settle #2** | SUCCESS, chains root | ✅ SUCCESS | [`2798ab54…e92b8c72`](https://stellar.expert/explorer/testnet/tx/2798ab54986751efbc5f1ab4aeb505cbf4c86a020d583fd28089af7ee92b8c72) | 99950 → **99900** | 50 → **100** | `2cffefaa…` → `0f8f7ece…` |
| **Compliant settle #3** | SUCCESS, chains root | ✅ SUCCESS | [`f8156f96…0c9bc3c5`](https://stellar.expert/explorer/testnet/tx/f8156f9600a754dd380b9fa454272c16582d0fda609da95c8d66b0600c9bc3c5) | 99900 → **99850** | 100 → **150** | `0f8f7ece…` → `5cadb2d4…` |
| **Forged proof** | revert on-chain | ✅ REVERTED `ProofInvalid #10` | [`903a71a2…bee19097`](https://stellar.expert/explorer/testnet/tx/903a71a2a4d14ccc47bd5cb6ade4b0a95b2eca1c66c5126e35637a25bee19097) | 99850 (unchanged) | 150 (unchanged) | `5cadb2d4…` (unchanged) |
| **Replay proof** | revert on-chain | ✅ REVERTED `StaleStateRoot #9` | [`d766b9c0…861d1d39`](https://stellar.expert/explorer/testnet/tx/d766b9c061dd9c38b236529ba6e665dfd08dd4bcec9fa1812ad4fe3b861d1d39) | 99850 (unchanged) | 150 (unchanged) | `5cadb2d4…` (unchanged) |
| Over-limit amount | no proof | ✅ witness fails | local `groth16.fullProve` error | — | — | — |
| Non-allowlisted recipient | no proof | ✅ witness fails | local `groth16.fullProve` error | — | — | — |
| Oracle re-mark / price breach | no proof | ✅ witness fails | local `groth16.fullProve` error | — | — | — |

The three compliant settlements each moved exactly 50 USDW (raw) into the recipient (150 total)
and walked the state root genesis → `2cffefaa…` → `0f8f7ece…` → `5cadb2d4…`. The forged and
replay transactions are **real, committed, explorer-visible testnet transactions that reverted**
and moved nothing — open the links and check the result is `FAILED` with the contract error code.
Pass `N_SETTLE=N` to chain more (up to the mandate cap).

The pre-chain rejections (over-limit amount, non-allowlisted recipient, oracle
price-breach) produce **no transaction at all**: `snarkjs.groth16.fullProve` cannot
build a witness, so nothing is ever submitted. That is the point — for those cases a
valid proof simply cannot exist.

## How to verify without the UI

No keys required for reads. With the [Stellar CLI](https://developers.stellar.org/docs/tools/cli):

```bash
C=CA4F7XRMZVDL4WKPKJIKGJUMFPI5HBCX5OV6N5BCHEDPHWVH4SVK3NFE
T=CBJ3ZUCZMLI5VSVFNHXAIWMYETEXKDLXH7UR7ZSF5WSL5OEPNQIACIQV
R=GAXIYPH63NUKNMGDGTMEHW3CR7XBXB3NA4FM4B2FK35Q23JVF4I2OGLE

# current state root and policy commitment
stellar contract invoke --id $C --network testnet --source-account <any> -- current_state_root
stellar contract invoke --id $C --network testnet --source-account <any> -- policy_commitment

# USDW custody balance and recipient balance
stellar contract invoke --id $T --network testnet --source-account <any> -- balance --id $C
stellar contract invoke --id $T --network testnet --source-account <any> -- balance --id $R
```

Or run the whole compliant + adversarial sequence on a fresh contract end-to-end:

```bash
npm install
node app/scripts/sdk/drive.mjs   # provisions fresh, prints real tx hashes + explorer links
```

## Running the wallet-native UI

```bash
cd app/frontend
npm install
npm run dev      # open the printed URL, install Freighter, set it to Testnet
```

Connect the wallet, fund the warrant, then click **Generate proof & settle**. The
forged/replay buttons submit real reverting transactions. Try over-limit / non-allowlisted
to see the proof fail before any transaction is built.

## Deploy to Vercel

`vercel.json` at the repo root makes this a one-click deploy — no dashboard settings,
no environment variables.

1. Push to GitHub (already done for this repo).
2. In Vercel, **Add New → Project → Import** this repository.
3. Leave every setting at its default and click **Deploy**. `vercel.json` already sets
   the build to `app/frontend` and the output to `app/frontend/dist`.

Notes:
- **No env vars are required.** The app reads its public config from
  `app/frontend/public/demo-config.json`. Do **not** add any `VITE_*` secret — Vite bundles
  those into browser code.
- The circuit (`.wasm`, 2.7 MB) and proving key (`.zkey`, 2.9 MB) are committed to git, so
  Vercel serves them and in-browser proving works on the deployed site.
- Visitors must install Freighter and set it to **Testnet**.

### Chained settlements and resetting

The agent's book evolves across **many** settlements. Each compliant proof extends the
previous on-chain state root, so a viewer can click *Generate proof & settle* repeatedly
and watch the position grow and the recipient get paid, settlement after settlement. The
frontend steps through a precomputed, deterministically-chained sequence
(`app/frontend/public/seq/`): on each click it reads the live on-chain root and proves the
input that extends it. The demo ships **12** chained settlements — the agent's position
climbs from the genesis book toward the private `maxPosition` cap.

When the position reaches the mandate cap, no further compliant proof can exist (the
position/drawdown limit working as designed), and the UI shows an "all settlements used"
message **without** submitting a doomed transaction.

The other demos:

- **Over-limit** and **non-allowlisted** (and the **oracle re-mark**) prove locally in the
  browser and fail at witness generation, so they work for everyone, any time.
- **Forged** and **replay** reuse the on-chain footprint of a *successful compliant
  settlement from the same session*, so they land as real reverted transactions right after
  any *Generate proof & settle*.

To see the **full** chained + forged + replay sequence land on-chain at any time
(it provisions a fresh contract every run), use the CLI driver instead of the hosted UI:

```bash
N_SETTLE=3 node app/scripts/sdk/drive.mjs   # fresh contract; prints real tx hashes + links
```

To reset the hosted demo to a fresh genesis contract (e.g. between recordings), re-provision
and redeploy:

```bash
npm install
npm run demo:reprovision   # writes app/frontend/public/demo-config.json + .keys.json
git add app/frontend/public/demo-config.json && git commit -m "Re-provision demo contract" && git push
```

`.keys.json` holds the new admin secret and is git-ignored — never commit it. Vercel
redeploys automatically on push.

## Wallet security

- The frontend **never** stores or uses a Stellar secret key. There is no
  `VITE_SOURCE_SECRET` and no `Keypair.fromSecret` in `app/frontend/src`.
- Every transaction is built in the app and **signed by the user's connected wallet**
  (Freighter) after explicit approval, via `signTransaction(xdr, …)`.
- `VITE_*` variables contain only public configuration (RPC URL, contract IDs,
  explorer base). **Never put a secret in a `VITE_*` variable** — Vite bundles those
  values into the browser JavaScript, exposing them to every visitor.
- Developer convenience scripts under `app/scripts/` may use a local secret (e.g.
  friendbot-funded keypairs) — but that is a CLI fallback that runs in your terminal,
  outside the browser, and is never the UI's signing path.
- `npm run audit:secrets` fails the build if any browser secret-signing pattern or
  fake transaction hash reappears in `app/frontend/src`.

## Recipient binding (honest scope)

The circuit proves the settlement targets an allowlisted **recipient id**; the contract
maps that id to an admin-registered Stellar `Address` (`register_recipient`) and transfers
only to that exact address. This is sufficient for the demo, where the allowlist is part
of the committed mandate. A production version would hash the recipient's Stellar address
bytes directly into the allowlist leaves and have the contract recompute and compare that
hash against the proof's public input, removing the admin-controlled id→address mapping.

## Limitations

- This is **testnet**, with a demo-sized mandate and demo proving artifacts (the trusted
  setup here is a demo ceremony, not a production MPC).
- Recipient binding uses recipient ids mapped to registered addresses (see above), not
  address-hash leaves.
- The live-oracle path reads the **real Reflector** SEP-40 feed on-chain; the alternate
  `settle_with_price` path uses an admin-signed price and is what the deterministic UI demo
  uses. A live price moves between rounds, so the oracle-priced demo settles from a
  price-independent genesis (position 0) within one Reflector update round.
- Production use needs audited circuits and contracts, a real trusted-setup ceremony,
  and hardened key management.

## Nothing is mocked

Every artifact in this project is real: real circom compilation, a real trusted setup,
real witnesses, real proofs, real testnet contracts, real wallet-signed transactions,
and real on-chain reads. Where a result is claimed, it is backed by a testnet transaction
hash or an on-chain return value.
