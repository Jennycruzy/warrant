#!/usr/bin/env node
// Frontend representation audit: verifies the public UI data, proof artifacts,
// and scenario files agree with the deployed-demo contract assumptions.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const pub = (...p) => join(ROOT, "app/frontend/public", ...p);
const src = (...p) => join(ROOT, "app/frontend/src", ...p);
const build = (...p) => join(ROOT, "app/build", ...p);

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  console.error(`frontend audit failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function hex32(decimal) {
  return BigInt(decimal).toString(16).padStart(64, "0");
}

function sameFile(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  const left = readFileSync(a);
  const right = readFileSync(b);
  return left.length === right.length && left.equals(right);
}

const cfg = json(pub("demo-config.json"));
const seq = json(pub("seq/manifest.json"));
const valid = json(pub("valid.input.json"));
const validMeta = json(pub("valid.input.json.meta.json"));
const overLimit = json(pub("over_limit.input.json"));
const overLimitMeta = json(pub("over_limit.input.json.meta.json"));
const nonAllow = json(pub("non_allow.input.json"));
const nonAllowMeta = json(pub("non_allow.input.json.meta.json"));
const breach = json(pub("breach.input.json"));
const breachMeta = json(pub("breach.input.json.meta.json"));

assert(cfg.contractId?.startsWith("C"), "demo-config contractId is missing or not a contract address");
assert(cfg.token?.startsWith("C"), "demo-config token is missing or not a contract address");
assert(cfg.recipient?.startsWith("G"), "demo-config recipient is missing or not an account address");
assert(cfg.signatureHex?.length === 128, "oracle signature must be 64 bytes hex");
assert(cfg.oraclePubKey?.length === 64, "oracle public key must be 32 bytes hex");

assert(cfg.commitmentHex === validMeta.commitmentHex, "valid input commitment differs from demo config");
assert(cfg.commitmentHex === seq.commitmentHex, "sequence commitment differs from demo config");
assert(cfg.genesisRootHex === validMeta.prevRootHex, "valid input genesis root differs from demo config");
assert(cfg.genesisRootHex === seq.genesisRootHex, "sequence genesis root differs from demo config");
assert(String(cfg.price) === String(valid.price), "valid input price differs from demo config");
assert(String(cfg.price) === String(seq.price), "sequence price differs from demo config");
assert(String(valid.amount) === String(seq.amount), "valid input amount differs from sequence amount");

const maxPerTx = BigInt(cfg.mandate.maxPerTx);
assert(BigInt(valid.amount) <= maxPerTx, "valid amount exceeds maxPerTx");
assert(BigInt(overLimit.amount) > maxPerTx, "over-limit scenario does not exceed maxPerTx");
assert(overLimitMeta.member === true, "over-limit scenario should keep allowlisted recipient");
assert(nonAllowMeta.member === false, "non-allow scenario should not be an allowlist member");
assert(String(nonAllow.amount) === String(valid.amount), "non-allow scenario should isolate recipient failure");
assert(BigInt(breach.price) < BigInt(cfg.price), "breach scenario should use a lower oracle mark");
assert(String(breach.amount) === String(valid.amount), "breach scenario should isolate oracle-price failure");

assert(Array.isArray(seq.settlements) && seq.settlements.length === seq.count, "sequence count mismatch");
let previousRoot = seq.genesisRootHex;
for (const settlement of seq.settlements) {
  const input = json(pub(settlement.file));
  assert(settlement.prevRootHex === previousRoot, `sequence root chain breaks before ${settlement.file}`);
  assert(hex32(input.prevStateRoot) === settlement.prevRootHex, `${settlement.file} prev root mismatch`);
  assert(hex32(input.nextStateRoot) === settlement.nextRootHex, `${settlement.file} next root mismatch`);
  assert(String(input.amount) === String(settlement.amount), `${settlement.file} amount mismatch`);
  assert(String(input.amount) === String(seq.amount), `${settlement.file} differs from fixed sequence amount`);
  assert(String(input.price) === String(seq.price), `${settlement.file} price mismatch`);
  previousRoot = settlement.nextRootHex;
}

const wasm = pub("circuits/mandate_oracle_allow.wasm");
const zkey = pub("proving/mandate_oracle_allow_final.zkey");
assert(statSync(wasm).size > 2_000_000, "frontend circuit wasm is unexpectedly small");
assert(statSync(zkey).size > 2_000_000, "frontend proving key is unexpectedly small");
assert(
  sameFile(wasm, build("mandate_oracle_allow_js/mandate_oracle_allow.wasm")),
  "frontend wasm differs from app/build artifact"
);
assert(
  sameFile(zkey, build("mandate_oracle_allow_final.zkey")),
  "frontend zkey differs from app/build artifact"
);

const app = readFileSync(src("App.jsx"), "utf8");
assert(app.includes("unsupportedAmount"), "App must fail closed for non-sequence compliant amounts");
assert(app.includes("Switch the wallet network to Stellar Testnet"), "App must block wrong wallet network");
assert(!/Keypair\.fromSecret|VITE_SOURCE_SECRET|FAKE_?HASH/i.test(app), "frontend source contains forbidden signing/fake pattern");

console.log(`frontend audit passed: ${seq.count} fixed-amount settlements, scenario files, artifacts, and UI guards are consistent.`);
