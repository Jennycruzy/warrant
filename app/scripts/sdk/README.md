# WARRANT SDK toolkit (`@stellar/stellar-sdk`)

A pure-Node toolkit that provisions and drives the WARRANT demo on Stellar testnet
**without** the Stellar CLI or a Rust/circom toolchain. It deploys a real test
stablecoin, deploys a fresh custody contract from the on-chain Wasm hash, proves
with snarkjs, and (next step) submits adversarial settlements that land as real
reverted on-chain transactions.

## Why this exists

The original `app/scripts/*.sh` scripts drive the demo through the Stellar CLI.
The CLI (and the current UI) simulate every call and abort before submitting, so a
forged proof or a replayed proof is rejected at *pre-flight* and never produces a
committed, reverted transaction with an explorer link. This toolkit fixes that:
it can borrow a valid simulation's footprint and force-submit a deliberately
invalid settlement, so the verifier's rejection is recorded as a real on-chain
reverted transaction.

## Files

- `encode.mjs` — circom/snarkjs → Soroban byte encoder (vk / proof / public),
  big-endian BLS12-381. **Verified byte-for-byte against the vk stored on the live
  contract** (1348 bytes, exact match).
- `chain.mjs` — SDK helpers: friendbot funding, deploy, invoke, read, and robust
  submission (Horizon-confirmed, re-simulates and resubmits through public-RPC
  read-replica lag / dropped txs). Includes `submitWithFootprint` for force-
  submitting failing txs so they revert on-chain.
- `provision.mjs` — deploy USDW stablecoin SAC, deploy warrant from the Wasm hash,
  `init` / `set_vk` / `set_oracle` / `register_recipient` / fund.
- `setup_demo.mjs` — end-to-end provisioning; writes `demo-config.json` + `.keys.json`.

## Usage

```bash
npm install
node app/scripts/sdk/setup_demo.mjs demo-config.json .keys.json
```

## Status (in progress)

- ✅ Encoders proven correct (vk byte-match; proof verifies on the live contract).
- ✅ USDW stablecoin SAC deploy, recipient trustline, warrant deploy-from-hash,
  `init`, `set_vk` all confirmed working on testnet.
- ✅ Robust submission (sequence/replica-lag retries, Horizon confirm, resubmit on
  drop, self-healing re-simulation for under-estimated resources).
- ⏳ Final green end-to-end `setup_demo` run (through `set_oracle`/`register`/fund)
  not yet re-verified after the self-healing fix.
- ⏳ Adversarial driver (compliant settle + forged-revert + replay-revert) not yet
  added here.
