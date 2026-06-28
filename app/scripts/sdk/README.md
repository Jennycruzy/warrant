# WARRANT SDK toolkit (`@stellar/stellar-sdk`)

A pure-Node toolkit that provisions and drives the WARRANT demo on Stellar testnet
**without** the Stellar CLI or a Rust/circom toolchain. It deploys a real test
stablecoin, deploys a fresh custody contract from the on-chain Wasm hash, proves
with snarkjs, submits a compliant settlement that succeeds, and force-submits
adversarial settlements that land as real, committed, reverted on-chain
transactions.

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
- `drive.mjs` — the full driver. With no args it provisions a fresh contract and
  runs Phase A (compliant settle → success, funds move, root advances) then Phase B
  (forged + replayed proofs force-submitted with the borrowed footprint → committed
  reverted txs). Pass `demo-config.json .keys.json` to drive an existing deployment.

## Usage

```bash
npm install
# provision only:
node app/scripts/sdk/setup_demo.mjs demo-config.json .keys.json
# provision a fresh contract AND drive compliant + adversarial in one shot:
node app/scripts/sdk/drive.mjs
```

## Status

- ✅ Encoders proven correct (vk byte-match; proof verifies on the live contract).
- ✅ USDW stablecoin SAC deploy, recipient trustline, warrant deploy-from-hash,
  `init`, `set_vk`, `set_oracle`, `register_recipient`, fund — full green
  `setup_demo` run confirmed on testnet.
- ✅ Robust submission (sequence/replica-lag retries, Horizon confirm, resubmit on
  drop, self-healing re-simulation for under-estimated resources).
- ✅ Adversarial driver done: compliant settle SUCCEEDS and forged/replay land as
  real committed REVERTED transactions, verified on Horizon. Example run:
  - compliant SUCCESS — tx `ff8478d26bcd710736671445ef407e3dda970d4c7efc6040a5c02022cec62d39`
  - forged  REVERT `Error(Contract,#10)` ProofInvalid — tx `a13e85c881f4d29f0c606175edb35411db351e7ca26215a6467221fd0202513c`
  - replay  REVERT `Error(Contract,#9)` StaleStateRoot — tx `9b91dffcae9a8ebe79d8f5d4ccc6ab7cd484b184b1912affb31c60ee4328ba17`

  (Explorer: `https://stellar.expert/explorer/testnet/tx/<hash>`.)
