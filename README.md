# WARRANT

Proof-carrying compliance for on-chain settlement.

WARRANT is a Soroban (Stellar) contract that releases a stablecoin **only** when a
Groth16 zero-knowledge proof shows the transfer obeys a pre-committed, private
mandate — and only when the move extends an on-chain state-root chain. No valid
proof, no movement. No matching prior state, rejected. The mandate and the book
stay private; only the proof, the public commitment, and the action are on-chain.

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

## Nothing is mocked

Every artifact in this project is real: real circom compilation, a real trusted setup,
real witnesses, real proofs, real testnet contracts, and real on-chain reads. Where a
result is claimed, it is backed by a testnet transaction hash or an on-chain return value.
