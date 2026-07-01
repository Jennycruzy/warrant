# WARRANT

**Provable, private, delegated spending on Stellar.**

## Who this is for

Delegating on-chain spending today usually forces a bad choice: publish the
limits and account state so everyone can audit them, or keep them private and
ask everyone to trust an off-chain claim.

WARRANT gives a principal both privacy and enforcement. The principal commits
delegation terms as a hash on Stellar, funds a custody contract, and lets a
delegated operator request payments. Funds move only when the operator produces
a zero-knowledge proof that the requested payment obeys the private terms,
extends the live state-root chain, and pays the exact approved recipient.

The spending limits, account balances, valuation rules, and approved-recipient
list stay confidential. The chain sees only a commitment, state roots, public
payment details, and the proof. No valid proof, no movement. No matching prior
state, rejected.

## How it works

WARRANT is a Soroban (Stellar) contract that releases a stablecoin **only** when a
Groth16 zero-knowledge proof shows the payment obeys pre-committed, private
delegation terms - and only when the payment extends an on-chain state-root
chain. The private account state never appears on-chain; only the proof, the
public commitment, and the public payment details do.

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

- **Principal** — sets the spending mandate (per-payment limit, exposure cap, and
  maximum permitted decline), commits its hash on-chain, funds the contract, and
  never reveals the private terms.
- **Delegated operator / prover** — holds the private account state and must
  produce a valid proof to request a payment. It cannot move money any other way.
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

## Authenticated valuation: Reflector (SEP-40)

The reference valuation can come from the **live [Reflector](https://reflector.network) oracle**, a
real decentralized price feed on Stellar. The contract's `settle_with_reflector` entrypoint
performs an on-chain **cross-contract call** to Reflector's SEP-40 `lastprice(Other(asset))`,
reads the authenticated price, and requires that exact price to be the price the Groth16 proof
was built against. No matching live price, no settlement - so the delegated operator can only
settle against a *current, real* valuation, and a proof built against any other price reverts
on-chain.

- Reflector testnet oracle (CEX/DEX feed, base USD, 14 decimals): `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63`
- Run it: `node app/scripts/sdk/drive_reflector.mjs` (provisions fresh, reads the live XLM/USD
  price, proves bound to it, settles via the on-chain Reflector read, then shows a wrong-price
  attempt revert).

Real testnet run (XLM/USD `17764414800342` ≈ $0.1776):

| Scenario | Expected | Actual | Tx |
| --- | --- | --- | --- |
| **Compliant, priced by live Reflector** | SUCCESS | ✅ SUCCESS, 50 moved, root advanced | [`d0053bba…fc826b1a`](https://stellar.expert/explorer/testnet/tx/d0053bba25f66d36249621b30380c5845b68fdc464d823f39a65ad7ffc826b1a) |
| **Proof bound to a fabricated price** | revert | ✅ REVERTED `PriceMismatch #15` (contract re-read Reflector) | [`1c90b4de…78dea775`](https://stellar.expert/explorer/testnet/tx/1c90b4de5ed8db88044ca07555be7e83544b036cdae24c626df7e6c878dea775) |

The contract also keeps a self-signed (Ed25519) valuation path (`settle_with_price`) for the
deterministic, replayable UI demo, whose fixed reference price keeps the chained settlement
sequence reproducible. Both paths bind the price as a verified public signal; only the
*source* differs (live Reflector vs an admin-signed report).

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
| Custody contract | `CCGUAXJ2SAGCQMVVJAL67CLQ735R2YOUFIBJMLCOBAMG2UNN4HVNMSSY` |
| USDW token (SAC) | `CCSRBXPDLPRYRAHDKR3HUJZJRALRSJK64CUBVQ4VNY7SIVOGU22QWXJX` |
| Account recipient | `GDV5O5MUNR3HLSWT2DPWIQBG6NE7ZIKPY563BVE4Z43GM6GBUCTQ7JLZ` |
| Contract recipient | `CBTDVUCVGRWA2QMSOIZ4S5LIZYJ5MKOZN2F6FCE3I57CA2B3PRTGBNVQ` |
| Recipient binding | `(type, 32 key bytes)` in the proof and approved-recipient commitment |
| Oracle public key (Ed25519) | `eaee897380a52a6b18205c33d79ed68e26f23ab85f46a9f74e044a989411af0b` |
| Network passphrase | `Test SDF Network ; September 2015` |
| Soroban RPC | `https://soroban-testnet.stellar.org` |
| Explorer | `https://stellar.expert/explorer/testnet` |

Live on-chain reads at the time of writing (no keys needed — see commands below):

- `policy_commitment` = `45e0b8cb7dca9bb70f91861d020e3c9978de9373baaecd23b833fbf20dabd28d`
- `current_state_root` = `45be8d721eb60367b8485489cb4668c6690bc8571750ade6ba195e97cba264f1` (genesis)
- USDW `decimals` = 7, `symbol` = `USDW`
- contract USDW balance = `100000` raw (0.01 USDW), recipient balance = `0`

This contract is intentionally left **at genesis** so a viewer can perform the first
of **2 chained** compliant settlements live from their own wallet: first to the account
recipient, then to the contract recipient.

## Evidence: chained payments + adversarial reverts on a fresh contract

`node app/scripts/sdk/drive_addr.mjs` provisions a brand-new address-bound warrant on
testnet and drives the core sequence as real, explorer-visible transactions: local
no-proof failures, redirect/type-confusion reverts, account and contract recipient
payments, then forged and replayed proof reverts. The run below is real testnet output:

- Fresh warrant: `CC5RSXUYNA7P4HYRLC5G37JM6A2B5NKRJ3CEWVNRPDIWFE5ZOMXVRESG`
- Contract recipient: `CDOAFUXJKGISKRJH2IUVLGFG2XHW73ZHT6XMST7FLKTO6RGQGJYUX3F4`

| Scenario | Expected | Actual | Tx hash / proof error | Custody (raw) | Recipient (raw) | State root |
| --- | --- | --- | --- | --- | --- | --- |
| Contract initialized + funded | genesis root | OK | (init + mint) | 100000 | 0 | `45be8d72…cba264f1` |
| **Redirect payment** | revert on-chain | REVERTED `RecipientMismatch #18` | [`647ed577…d57b6b4`](https://stellar.expert/explorer/testnet/tx/647ed577e7e66ade4b1f667546d8ad8788e6815a4ea5e7ad5a94b52b1d57b6b4) | unchanged | unchanged | unchanged |
| **Type confusion** | revert on-chain | REVERTED `RecipientTypeMismatch #19` | [`420f3661…be11ca2`](https://stellar.expert/explorer/testnet/tx/420f3661d6c88e3ee45d668773886ac878e0db035e74a808cc3a1253abe11ca2) | unchanged | unchanged | unchanged |
| **Compliant account payment** | SUCCESS, pays account | SUCCESS | [`7e3bf515…c045b17`](https://stellar.expert/explorer/testnet/tx/7e3bf515ad0d55e4c5208d5ddbfa154af429192d9555def3d84b8375bc045b17) | 100000 → **99990** | 0 → **10** | `45be8d72…` → `07e66e8c…` |
| **Compliant contract payment** | SUCCESS, pays contract | SUCCESS | [`157f9e81…168ff13`](https://stellar.expert/explorer/testnet/tx/157f9e818244dab8cffd5e9a0d2e702164c5f663cfbcb867486d6294f168ff13) | 99990 → **99980** | 0 → **10** | `07e66e8c…` → `11b6e849…` |
| **Forged proof** | revert on-chain | REVERTED `ProofInvalid #10` | [`3dafbadb…52e776b`](https://stellar.expert/explorer/testnet/tx/3dafbadbb1ae88cf3f96e17181678e2e95798263155144e543b0f5f3d52e776b) | unchanged | unchanged | unchanged |
| **Replay proof** | revert on-chain | REVERTED `StaleStateRoot #9` | [`e1828d4b…73c09fc`](https://stellar.expert/explorer/testnet/tx/e1828d4b779996d42a9af9e7779ea86cc5ae712cd3e92bde1dbea855873c09fc) | unchanged | unchanged | unchanged |
| Over-limit amount | no proof | witness fails | local `groth16.fullProve` error | — | — | — |
| Over exposure cap | no proof | witness fails | local `groth16.fullProve` error | — | — | — |
| Lower valuation / permitted-decline breach | no proof | witness fails | local `groth16.fullProve` error | — | — | — |
| Wrong type for approved bytes | no proof | witness fails | local approved-list lookup / witness failure | — | — | — |

The compliant account and contract payments each moved exactly 10 USDW (raw) and walked
the state root genesis → `07e66e8c…` → `11b6e849…`. The redirect, type-confusion, forged,
and replay transactions are **real, committed, explorer-visible testnet transactions that
reverted** and moved nothing.

The pre-chain rejections (over-limit amount, non-approved recipient, lower-valuation
breach) produce **no transaction at all**: `snarkjs.groth16.fullProve` cannot
build a witness, so nothing is ever submitted. That is the point — for those cases a
valid proof simply cannot exist.

## Why ZK is load-bearing

WARRANT is not a UI permission screen or an off-chain policy engine. If the proof is removed,
the mechanism collapses into a claim that someone checked the rules elsewhere. With the proof
in place, the private rules stay hidden while the contract still enforces them before releasing
funds. The state-root chain is equally load-bearing: it prevents replay and forces every valid
payment to extend the same committed account history.

## How to verify without the UI

No keys required for reads. With the [Stellar CLI](https://developers.stellar.org/docs/tools/cli):

```bash
C=CCGUAXJ2SAGCQMVVJAL67CLQ735R2YOUFIBJMLCOBAMG2UNN4HVNMSSY
T=CCSRBXPDLPRYRAHDKR3HUJZJRALRSJK64CUBVQ4VNY7SIVOGU22QWXJX
R=GDV5O5MUNR3HLSWT2DPWIQBG6NE7ZIKPY563BVE4Z43GM6GBUCTQ7JLZ

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
node app/scripts/sdk/drive_addr.mjs   # provisions fresh, prints real tx hashes + explorer links
```

## Running the wallet-native UI

```bash
cd app/frontend
npm install
npm run dev      # open the printed URL, install Freighter, set it to Testnet
```

Connect the wallet, then click **Generate proof & pay**. The current demo proves and
settles the amount and approved recipient currently selected in the UI. The forged/replay,
redirect, and type-confusion buttons submit real reverting transactions. Try over-limit,
over-exposure, or non-approved settings to see the proof fail before any transaction is built.

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
- The address-bound circuit (`.wasm`, 2.7 MB) and proving key (`.zkey`, 3.2 MB) are committed to git, so
  Vercel serves them and in-browser proving works on the deployed site.
- Visitors must install Freighter and set it to **Testnet**.

### Chained payments and resetting

The delegated account state evolves across settlements. Each compliant proof extends the
previous on-chain state root, so a viewer can click *Generate proof & pay* and
watch the holdings value grow and the selected recipient get paid. The frontend reads the live
on-chain root, matches it to the committed address-bound control table
(`app/frontend/public/controls/manifest.json`), then builds the witness input from the
viewer-selected amount, recipient identity, and private account state for that root. It still
runs real `snarkjs.groth16.fullProve` in the browser; the control table contains roots and
Merkle paths, not proofs.

When the holdings value reaches the exposure cap, no further compliant proof can exist (the
exposure and permitted-decline limits working as designed), and the UI shows a witness-generation refusal
message **without** submitting a doomed transaction.

The other demos:

- **Over-limit** and **non-approved recipient** (and the **lower valuation**) prove locally in the
  browser and fail at witness generation, so they work for everyone, any time.
- **Forged** and **replay** reuse the on-chain footprint of a *successful compliant
  settlement from the same session*, so they land as real reverted transactions right after
  any *Generate proof & pay*.

To see the **full** chained + forged + replay sequence land on-chain at any time
(it provisions a fresh contract every run), use the CLI driver instead of the hosted UI:

```bash
node app/scripts/sdk/drive_addr.mjs   # fresh contract; prints real tx hashes + links
```

To reset the hosted demo to a fresh genesis contract (e.g. between recordings), re-provision
and redeploy:

```bash
npm install
node app/scripts/sdk/setup_addr_demo.mjs   # writes address-bound frontend config and artifacts
git add app/frontend/public/demo-config.json app/frontend/public/*.input.json app/frontend/public/*.meta.json app/frontend/public/seq
git add -f app/frontend/public/circuits/mandate_oracle_allow_addr.wasm app/frontend/public/proving/mandate_oracle_allow_addr_final.zkey
git commit -m "Re-provision address-bound demo contract" && git push
```

`.keys.json` holds the new admin secret and is git-ignored — never commit it. Vercel
redeploys automatically on push.

Rollback is a config-only switch: `app/frontend/public/demo-config.json` includes a
`rollback` object pointing at the previous id-based contract and the previous
`mandate_oracle_allow` artifacts. Restoring those values returns the UI to the old path;
the old contract and circuit remain deployed alongside the address-bound path.

## Beyond delegation: autonomous agents

Autonomous agents are one application of the same primitive, not a separate mechanism. An
agent that controls funds can be treated as a delegated operator: it may propose payments,
but the contract releases funds only when a proof shows the action respects the private
spending mandate, approved-recipient commitment, live state root, and authenticated
valuation. The same construction also fits human operators, treasury workflows, grant
disbursement, and regulated counterparties.

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

The address-bound path removes the recipient-id indirection. The circuit exposes
`recipientType`, `recipientHi`, and `recipientLo` as public signals, where type is
`0 = account` and `1 = contract`, and the 32 identity bytes are split big-endian into
two 128-bit limbs. The committed approved-recipient leaf is `Poseidon(type, hi, lo)`, computed
inside the BLS12-381 circuit. The Soroban contract computes no Poseidon; after the
Groth16 proof verifies, it extracts the caller-supplied `Address` payload with the SDK,
maps it to the same type code, performs plain equality against the verified public
signals, and transfers only to that exact address.

Binding the type is primarily about capability and a clean identity model: the same
system can pay both accounts (`G...`) and contracts (`C...`) with no account-only
caveat. A cross-type 32-byte collision is not a realistic operational concern, so the
type tag is capability and clarity first, defense-in-depth second.

There is no `register_recipient` entrypoint on the new contract. The exported function
list is `init`, `set_vk`, `set_oracle`, `fund`, `settle`, `settle_with_price`,
`settle_with_reflector`, `current_state_root`, `policy_commitment`, and `get_token`.

## Limitations

- This is **testnet**, with demo-sized delegation terms and demo proving artifacts (the trusted
  setup here is a demo ceremony, not a production MPC).
- Recipient identity is now bound as `(type, key bytes)` in the proof and committed
  approved-recipient data. The contract enforces exact type-and-byte equality and computes no Poseidon.
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
