# WARRANT

**Private mandate. Public settlement.**

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

## Toolchain

- circom 2.2.3 (built from source)
- snarkjs 0.7.6
- Stellar CLI 27.0.0, targeting testnet
- Rust (stable) with `wasm32v1-none` for the Soroban contract

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
| Warrant contract | `CBOFK4I5LHP653B3YPBJEYSR5JE7F6NRYXW2KPFBWQPP6ATQHNBOLT7W` |
| USDW token (SAC) | `CDA2EF72QUX4TZPMBD2D2D37QVXJK3RGGILIBMSEFMZQLR55FIH7P4XL` |
| Recipient 0 | `GCWEVQJSSYMEEJW3NE4GNN3B7JSCZ3Z3ZI24AB3YFPIDYEL45GRLFGNL` |
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
compliant settlement live from their own wallet.

## Evidence: the full sequence on a fresh contract

`node app/scripts/sdk/drive.mjs` provisions a brand-new warrant on testnet and drives
the whole sequence as real, explorer-visible transactions (compliant settlement,
forged proof, replayed proof). The run below is real testnet output:

- Fresh warrant: `CBGEHDCK6MFQSIMRGAJ2EXOEEGZXVF47QO5OI66C26YBK3Y2OQU26R6W`
- Fresh USDW token: `CCSVPYDZP774HT3DTWVXHRR5CYZ5SI756TTRBYEVJA6EXVK6PYXXXROQ`
- Submitter/admin: `GDTIPALCVH4HENB3TDPMZC2T7DALO7TT2U57Z5NEX4GE23MHYM65TLRL`
- Recipient 0: `GC4VICLKMH7QU7XSFSTHDO76Q2ZVJUDXPLGZ7LUZ72LZELRGAYV3P5MY`

| Scenario | Expected | Actual | Tx hash / proof error | Custody (raw) | Recipient (raw) | State root |
| --- | --- | --- | --- | --- | --- | --- |
| Contract initialized | genesis root | OK | (init) | 100000 | 0 | `45be8d72…cba264f1` |
| Contract funded (USDW) | 100000 custodied | OK | (mint) | 100000 | 0 | `45be8d72…cba264f1` |
| **Compliant settlement** | SUCCESS, pays recipient | ✅ SUCCESS | [`62780ea4…04eb12e9`](https://stellar.expert/explorer/testnet/tx/62780ea454861453e351f4247ec3ff6d62c2f56cb0a65e043510270a04eb12e9) | 100000 → **99950** | 0 → **50** | `45be8d72…` → **`6511339d…f8f253a7`** |
| **Forged proof** | revert on-chain | ✅ REVERTED `ProofInvalid #10` | [`21f51b19…79f4b1c1`](https://stellar.expert/explorer/testnet/tx/21f51b19a900dd766da6b88ae8cead053f42a8fe28b744e819c406d179f4b1c1) | 99950 (unchanged) | 50 (unchanged) | `6511339d…` (unchanged) |
| **Replay proof** | revert on-chain | ✅ REVERTED `StaleStateRoot #9` | [`fdfcbb35…e842d51f9c`](https://stellar.expert/explorer/testnet/tx/fdfcbb355737282cd83f04cb496d79ae823c5efaaa111c550e7535e842d51f9c) | 99950 (unchanged) | 50 (unchanged) | `6511339d…` (unchanged) |
| Over-limit amount | no proof | ✅ witness fails | local `groth16.fullProve` error | — | — | — |
| Non-allowlisted recipient | no proof | ✅ witness fails | local `groth16.fullProve` error | — | — | — |
| Oracle re-mark / price breach | no proof | ✅ witness fails | local `groth16.fullProve` error | — | — | — |

The compliant settlement moved exactly 50 USDW (raw) into the recipient and advanced
the state root from genesis to `6511339d…`. The forged and replay transactions are
**real, committed, explorer-visible testnet transactions that reverted** and moved
nothing — open the links and check the result is `FAILED` with the contract error code.

The pre-chain rejections (over-limit amount, non-allowlisted recipient, oracle
price-breach) produce **no transaction at all**: `snarkjs.groth16.fullProve` cannot
build a witness, so nothing is ever submitted. That is the point — for those cases a
valid proof simply cannot exist.

## How to verify without the UI

No keys required for reads. With the [Stellar CLI](https://developers.stellar.org/docs/tools/cli):

```bash
C=CBOFK4I5LHP653B3YPBJEYSR5JE7F6NRYXW2KPFBWQPP6ATQHNBOLT7W
T=CDA2EF72QUX4TZPMBD2D2D37QVXJK3RGGILIBMSEFMZQLR55FIH7P4XL
R=GCWEVQJSSYMEEJW3NE4GNN3B7JSCZ3Z3ZI24AB3YFPIDYEL45GRLFGNL

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

### One-shot settlement and resetting

The bundled compliant proof extends the **genesis** book state, and the demo mandate
(`maxPosition`, `peakEquity`, fixed oracle price) is calibrated so that **exactly one
meaningful compliant settlement is provable per contract** — the private position starts
at the equity cap and only grows, so no valid witness exists for a second settlement.
This is the replay/risk protection working as designed.

So on a hosted link, the **first** visitor's *Generate proof & settle* lands a real
settlement; afterwards the UI detects that the on-chain root has advanced and shows a
clear "already used" message **without** submitting a doomed transaction. Forged, replay,
over-limit, and non-allowlisted attempts keep working for everyone.

To make *settle* available again (e.g. between demo recordings), re-provision a fresh
genesis contract and redeploy:

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
- Production use needs audited circuits and contracts, a real trusted-setup ceremony,
  and hardened oracle/key management.

## Nothing is mocked

Every artifact in this project is real: real circom compilation, a real trusted setup,
real witnesses, real proofs, real testnet contracts, real wallet-signed transactions,
and real on-chain reads. Where a result is claimed, it is backed by a testnet transaction
hash or an on-chain return value.
