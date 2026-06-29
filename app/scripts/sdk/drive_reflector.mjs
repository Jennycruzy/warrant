// WARRANT live-oracle driver: settle gated by a REAL Reflector price read on-chain.
//
// Provisions a fresh contract, reads the live XLM/USD price from the Reflector
// SEP-40 oracle, proves a compliant settlement bound to that exact price, and
// calls settle_with_reflector — where the CONTRACT itself re-reads Reflector and
// requires the price to match the proof. Then it shows a price-mismatch attempt
// (proof built with a wrong price) reverting on-chain.
//
//   node app/scripts/sdk/drive_reflector.mjs
import * as snarkjs from "snarkjs";
import { createRequire } from "module";
import {
  S, server, submitAuto, submitWithFootprint, invoke, read,
  scBytes, scAddr, explorerTx, explorerC,
} from "./chain.mjs";
import {
  getVkHex, makeKeys, fundKeys, deployStablecoin, trustline,
  deployWarrant, configureWarrant, REFLECTOR,
} from "./provision.mjs";
import { proofToHex, publicToHex } from "./encode.mjs";

const require = createRequire(import.meta.url);
const { poseidon3, poseidon4 } = require("../poseidon.js");
const { buildTree, proofForIndex } = require("../allowlist.js");

const MANDATE = { maxPerTx: "100", maxPosition: "1000", drawdownLimit: "100" };
const ALLOW = { depth: 3, leaves: ["0"] };
// Genesis position 0 => currentEquity = 0*price = 0, so the genesis state root is
// PRICE-INDEPENDENT. That lets the (multi-minute) provisioning happen at any price;
// only the short prove->settle window must stay inside one Reflector update round.
const POS = 0n, AMOUNT = 50n, FUND = "100000";
const ART = (p) => new URL(`../../frontend/public/${p}`, import.meta.url).pathname;
const WASM = ART("circuits/mandate_oracle_allow.wasm");
const ZKEY = ART("proving/mandate_oracle_allow_final.zkey");
const hx = (u8) => (u8 == null ? null : Buffer.from(u8).toString("hex"));
const dec2hex32 = (d) => BigInt(d).toString(16).padStart(64, "0");
const scSym = (s) => S.nativeToScVal(s, { type: "symbol" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SEP-40 Asset::Other(symbol) for a lastprice() read.
const otherAsset = (sym) => S.xdr.ScVal.scvVec([S.xdr.ScVal.scvSymbol("Other"), S.xdr.ScVal.scvSymbol(sym)]);

async function reflectorPrice() {
  const r = await read(REFLECTOR.contract, "lastprice", [otherAsset(REFLECTOR.asset)]);
  if (r.error || !r.value) throw new Error("Reflector lastprice unavailable: " + (r.error || "none"));
  return BigInt(r.value.price);
}

// Build + prove a compliant settlement bound to `price`, from book (position, peak).
async function proveAt(price, position, peak) {
  const tree = await buildTree(ALLOW.leaves, ALLOW.depth);
  const { pathElements, pathIndices } = proofForIndex(tree, 0);
  const currentEquity = position * price;
  const nextPosition = position + AMOUNT;
  const nextEquity = nextPosition * price;
  const nextPeak = nextEquity >= peak ? nextEquity : peak;
  const policyCommitment = await poseidon4(MANDATE.maxPerTx, MANDATE.maxPosition, MANDATE.drawdownLimit, tree.root);
  const prevStateRoot = await poseidon3(position.toString(), peak.toString(), currentEquity.toString());
  const nextStateRoot = await poseidon3(nextPosition.toString(), nextPeak.toString(), nextEquity.toString());
  const input = {
    policyCommitment, prevStateRoot, nextStateRoot,
    amount: AMOUNT.toString(), recipient: "0", price: price.toString(),
    ...MANDATE, allowlistRoot: tree.root,
    prevPosition: position.toString(), peakEquity: peak.toString(),
    pathElements, pathIndices,
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  return { proofHex: proofToHex(proof), publicHex: publicToHex(publicSignals), publicSignals, commitmentHex: dec2hex32(policyCommitment), genesisHex: dec2hex32(prevStateRoot), nextHex: dec2hex32(nextStateRoot) };
}

async function readState(CID, TOKEN, recipient) {
  const root = hx((await read(CID, "current_state_root")).value);
  const cbal = (await read(TOKEN, "balance", [scAddr(CID)])).value?.toString();
  const rbal = (await read(TOKEN, "balance", [scAddr(recipient)])).value?.toString();
  return { root, cbal, rbal };
}
async function waitForState(CID, TOKEN, recipient, pred, tries = 20) {
  let s;
  for (let i = 0; i < tries; i++) { s = await readState(CID, TOKEN, recipient); if (pred(s)) return s; await sleep(2000); }
  return s;
}
async function failReason(hash) {
  for (let i = 0; i < 8; i++) {
    const t = await server.getTransaction(hash);
    if (t.status === "FAILED") {
      for (const d of t.diagnosticEventsXdr || []) {
        let ev; try { ev = typeof d === "string" ? S.xdr.DiagnosticEvent.fromXDR(d, "base64") : d; } catch { continue; }
        try {
          const v0 = ev.event().body().v0();
          const topics = v0.topics().map((x) => { try { return S.scValToNative(x); } catch { return x.switch().name; } });
          if (String(topics[0]) === "error") return JSON.stringify(topics, (k, v) => (typeof v === "bigint" ? v.toString() : v));
        } catch { /* skip */ }
      }
      return "FAILED (no diagnostic)";
    }
    await sleep(1200);
  }
  return "FAILED (unresolved)";
}

// ---- provision a fresh contract ----
console.log("== WARRANT live Reflector-oracle demo (real testnet) ==\n");
const live0 = await reflectorPrice();
console.log(`Reflector ${REFLECTOR.asset}/USD live price (14 dec): ${live0}  (~$${(Number(live0) / 1e14).toFixed(6)})`);
console.log(`Reflector oracle: ${explorerC(REFLECTOR.contract)}\n`);

const keys = makeKeys();
await fundKeys(keys);
const { asset, tokenId } = await deployStablecoin(keys.admin);
await trustline(keys.recipient, asset);
const vkHex = await getVkHex();
const warrantId = await deployWarrant(keys.admin);

// Build the genesis book at the live price so the first proof extends it.
const seed = await proveAt(live0, POS, POS * live0);
await configureWarrant({
  admin: keys.admin, recipient: keys.recipient, warrantId, tokenId,
  commitmentHex: seed.commitmentHex, genesisRootHex: seed.genesisHex, vkHex, fundAmount: FUND,
});
const CID = warrantId, RECIP = keys.recipient.publicKey();
console.log("warrant  :", explorerC(CID));
console.log("submitter:", keys.admin.publicKey(), "\n");

const settleOp = (proofHex, publicHex) =>
  invoke(CID, "settle_with_reflector", [scBytes(proofHex), scBytes(publicHex), scAddr(REFLECTOR.contract), scSym(REFLECTOR.asset)]);

// ---- Phase A: compliant settle gated by the live oracle ----
console.log("Phase A — COMPLIANT settle priced by the LIVE Reflector oracle (must SUCCEED)");
const before = await waitForState(CID, tokenId, RECIP, (s) => s.cbal === FUND);
console.log(`  before: root=${before.root.slice(0, 14)}… custody=${before.cbal} recipient=${before.rbal}`);

// Re-read the price right before proving so prover and contract agree on the round.
const price = await reflectorPrice();
const v = await proveAt(price, POS, POS * price);
console.log(`  proved settlement bound to price=${price}; submitting (contract re-reads Reflector)…`);
const okRes = await submitAuto(settleOp(v.proofHex, v.publicHex), keys.admin, "settle_with_reflector");
const after = await waitForState(CID, tokenId, RECIP, (s) => s.root === v.nextHex && BigInt(s.cbal) === BigInt(before.cbal) - AMOUNT);
const moved = after.root === v.nextHex && BigInt(before.cbal) - BigInt(after.cbal) === AMOUNT && BigInt(after.rbal) - BigInt(before.rbal) === AMOUNT;
console.log(`  ✅ SUCCESS ${explorerTx(okRes.hash)}`);
console.log(`  root ${before.root.slice(0, 14)}…->${after.root.slice(0, 14)}…  custody ${before.cbal}->${after.cbal}  recipient ${before.rbal}->${after.rbal}  ${moved ? "VERIFIED ✅" : "MISMATCH ❌"}\n`);

const sorobanB64 = okRes.sim.transactionData.build().toXDR("base64");
const minResourceFee = okRes.sim.minResourceFee;

// ---- Phase B: a proof built with the WRONG price is rejected by the live oracle ----
console.log("Phase B — WRONG-PRICE settle (proof bound to a fabricated price; must REVERT)");
const fake = price + 1n;
const w = await proveAt(fake, POS, POS * fake);
const bad = await submitWithFootprint(settleOp(w.proofHex, w.publicHex), keys.admin, sorobanB64, minResourceFee, "wrong-price");
console.log(`  WRONG-PRICE ${bad.status === "FAILED" ? "✅ REVERTED" : "❌ " + bad.status}: ${explorerTx(bad.hash)}`);
console.log("    reason:", bad.status === "FAILED" ? await failReason(bad.hash) : "(landed unexpectedly)");

const end = await waitForState(CID, tokenId, RECIP, () => true, 1);
console.log(`  custody=${end.cbal} recipient=${end.rbal}: wrong-price moved nothing: ${end.cbal === after.cbal ? "VERIFIED ✅" : "STATE CHANGED ❌"}`);

console.log("\n== SUMMARY (all real testnet transactions) ==");
console.log("live oracle      :", explorerC(REFLECTOR.contract), `(${REFLECTOR.asset}/USD)`);
console.log("compliant SUCCESS:", explorerTx(okRes.hash));
console.log("wrong-price REVERT:", explorerTx(bad.hash), `(${bad.status}, PriceMismatch #15)`);
