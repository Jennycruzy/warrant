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

echo "== frontend production build =="
npm --prefix app/frontend run build

echo "== rust format check =="
cargo fmt --manifest-path app/Cargo.toml --all -- --check

echo "== rust tests =="
cargo test --manifest-path app/Cargo.toml

echo "== contract wasm release build =="
cargo build --manifest-path app/Cargo.toml --target wasm32v1-none --release -p warrant

echo "== local chained proof verification =="
node app/scripts/verify_multisettle.mjs 5

echo "== invalid witness/proof cases =="
node --input-type=module -e '
import * as snarkjs from "snarkjs";
const cases = ["over_limit", "non_allow", "breach"];
let ok = true;
for (const c of cases) {
  try {
    const input = (await import(`./app/frontend/public/${c}.input.json`, { with: { type: "json" } })).default;
    await snarkjs.groth16.fullProve(
      input,
      "app/frontend/public/circuits/mandate_oracle_allow.wasm",
      "app/frontend/public/proving/mandate_oracle_allow_final.zkey"
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
cmp -s app/build/mandate_oracle_allow_js/mandate_oracle_allow.wasm app/frontend/public/circuits/mandate_oracle_allow.wasm
cmp -s app/build/mandate_oracle_allow_final.zkey app/frontend/public/proving/mandate_oracle_allow_final.zkey

node -e '
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync("app/frontend/public/demo-config.json"));
const seq = JSON.parse(fs.readFileSync("app/frontend/public/seq/manifest.json"));
const meta = JSON.parse(fs.readFileSync("app/frontend/public/valid.input.json.meta.json"));
let ok = cfg.commitmentHex === seq.commitmentHex &&
  cfg.commitmentHex === meta.commitmentHex &&
  cfg.genesisRootHex === seq.genesisRootHex &&
  cfg.genesisRootHex === meta.prevRootHex &&
  String(cfg.price) === String(seq.price) &&
  String(cfg.price) === String(meta.price);
for (const s of seq.settlements) {
  const input = JSON.parse(fs.readFileSync("app/frontend/public/" + s.file));
  const hx = (d) => BigInt(d).toString(16).padStart(64, "0");
  ok = ok && hx(input.prevStateRoot) === s.prevRootHex &&
    hx(input.nextStateRoot) === s.nextRootHex &&
    String(input.amount) === String(s.amount);
}
if (!ok) {
  console.error("demo config, metadata, or sequence manifest is inconsistent");
  process.exit(1);
}
console.log(`demo config and ${seq.count} sequence inputs are consistent`);
'

echo "ALL LOCAL AUDIT CHECKS PASSED"
