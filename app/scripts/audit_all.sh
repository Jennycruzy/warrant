#!/usr/bin/env bash
# Run the local, non-network audit suite. Installs rustfmt only if the current
# Rust toolchain is missing it, so repeat runs do not reinstall tooling.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need node
need npm
need cargo
need rustup

if ! cargo fmt --version >/dev/null 2>&1; then
  echo "rustfmt missing; installing rustfmt component once..."
  rustup component add rustfmt
fi

if [ ! -d node_modules ]; then
  echo "root node_modules missing; running npm install..."
  npm install
fi

if [ ! -d app/frontend/node_modules ]; then
  echo "frontend node_modules missing; running npm --prefix app/frontend install..."
  npm --prefix app/frontend install
fi

echo "== frontend/browser secret audit =="
npm run test

echo "== frontend representation audit =="
npm run audit:frontend

echo "== javascript lint =="
npm run lint

echo "== frontend production build =="
npm --prefix app/frontend run build

echo "== rust format check =="
cargo fmt --manifest-path app/Cargo.toml --all -- --check

echo "== rust tests =="
cargo test --manifest-path app/Cargo.toml

echo "== contract wasm release build =="
cargo build --manifest-path app/Cargo.toml --target wasm32v1-none --release -p warrant
cargo build --manifest-path app/Cargo.toml --target wasm32v1-none --release -p warrant-addr

echo "== address identity convention =="
node app/scripts/test_address_identity.mjs

echo "== local chained proof verification =="
node app/scripts/verify_multisettle.mjs 5

echo "== address-bound valid proof cases =="
node --input-type=module -e '
import * as snarkjs from "snarkjs";
import fs from "node:fs";
const cfg = JSON.parse(fs.readFileSync("app/frontend/public/demo-config.json"));
const wasm = `app/frontend/public${cfg.circuitWasm}`;
const zkey = `app/frontend/public${cfg.provingKey}`;
const vk = JSON.parse(fs.readFileSync("app/build/mandate_oracle_allow_addr_vk.json"));
for (const file of ["valid.input.json", "seq/settle_01.input.json", "seq/settle_02.input.json"]) {
  const input = JSON.parse(fs.readFileSync(`app/frontend/public/${file}`));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) {
    console.error(`${file}: proof did not verify`);
    process.exit(1);
  }
  console.log(`${file}: proof verified`);
}
const controls = JSON.parse(fs.readFileSync("app/frontend/public/controls/manifest.json"));
const state = controls.states.find((s) => s.rootHex === cfg.genesisRootHex);
const nextState = controls.states.find((s) => s.position === "137");
const recipient = controls.recipients.find((r) => String(r.id) === "1");
const controlInput = {
  policyCommitment: controls.policyCommitment,
  prevStateRoot: state.root,
  nextStateRoot: nextState.root,
  amount: "37",
  recipientType: recipient.recipientType,
  recipientHi: recipient.recipientHi,
  recipientLo: recipient.recipientLo,
  price: controls.price,
  maxPerTx: controls.mandate.maxPerTx,
  maxPosition: controls.mandate.maxPosition,
  drawdownLimit: controls.mandate.drawdownLimit,
  allowlistRoot: controls.allowlistRoot,
  prevPosition: state.position,
  peakEquity: state.peakEquity,
  pathElements: recipient.pathElements,
  pathIndices: recipient.pathIndices,
};
{
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(controlInput, wasm, zkey);
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) {
    console.error("control manifest amount 37 proof did not verify");
    process.exit(1);
  }
  console.log("control manifest amount 37 to contract recipient: proof verified");
}
process.exit(0);
'

echo "== invalid witness/proof cases =="
timeout 120s node --input-type=module -e '
import * as snarkjs from "snarkjs";
import fs from "node:fs";
const cfg = JSON.parse(fs.readFileSync("app/frontend/public/demo-config.json"));
const wasm = `app/frontend/public${cfg.circuitWasm}`;
const zkey = `app/frontend/public${cfg.provingKey}`;
const cases = ["over_limit", "non_allow", "breach"];
let ok = true;
for (const c of cases) {
  try {
    const input = JSON.parse(fs.readFileSync(`app/frontend/public/${c}.input.json`));
    await snarkjs.groth16.fullProve(
      input,
      wasm,
      zkey
    );
    console.error(`${c}: unexpectedly produced a proof`);
    ok = false;
  } catch {
    console.log(`${c}: witness/proof rejected as expected`);
  }
}
process.exit(ok ? 0 : 1);
'

echo "== committed artifact consistency =="
cmp -s app/build/mandate_oracle_allow_addr_js/mandate_oracle_allow_addr.wasm app/frontend/public/circuits/mandate_oracle_allow_addr.wasm
cmp -s app/build/mandate_oracle_allow_addr_final.zkey app/frontend/public/proving/mandate_oracle_allow_addr_final.zkey

node -e '
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync("app/frontend/public/demo-config.json"));
const seq = JSON.parse(fs.readFileSync("app/frontend/public/seq/manifest.json"));
const meta = JSON.parse(fs.readFileSync("app/frontend/public/valid.input.json.meta.json"));
const controls = JSON.parse(fs.readFileSync("app/frontend/public/controls/manifest.json"));
let ok = cfg.commitmentHex === seq.commitmentHex &&
  cfg.commitmentHex === meta.commitmentHex &&
  cfg.commitmentHex === controls.commitmentHex &&
  cfg.genesisRootHex === seq.genesisRootHex &&
  cfg.genesisRootHex === meta.prevRootHex &&
  cfg.genesisRootHex === controls.genesisRootHex &&
  String(cfg.price) === String(seq.price) &&
  String(cfg.price) === String(meta.price) &&
  String(cfg.price) === String(controls.price);
for (const s of seq.settlements) {
  const input = JSON.parse(fs.readFileSync("app/frontend/public/" + s.file));
  const hx = (d) => BigInt(d).toString(16).padStart(64, "0");
  ok = ok && hx(input.prevStateRoot) === s.prevRootHex &&
    hx(input.nextStateRoot) === s.nextRootHex &&
    input.recipientType !== undefined &&
    input.recipientHi !== undefined &&
    input.recipientLo !== undefined &&
    String(input.amount) === String(s.amount);
}
if (!ok) {
  console.error("demo config, metadata, or sequence manifest is inconsistent");
  process.exit(1);
}
console.log(`demo config and ${seq.count} sequence inputs are consistent`);
'

echo "ALL LOCAL AUDIT CHECKS PASSED"
