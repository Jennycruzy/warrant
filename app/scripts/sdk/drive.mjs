// WARRANT real on-chain driver (compliant + adversarial), pure @stellar/stellar-sdk.
//
// Deterministic and self-contained: with no arguments it provisions a FRESH
// custody contract on testnet (USDW SAC + deploy-from-wasm-hash + init/set_vk/
// set_oracle/register/fund) and then drives the full sequence:
//
//   Phase A (compliant): prove with snarkjs, submit settle_with_price; it
//     SUCCEEDS — 50 USDW moves and the state root advances genesis -> next.
//   Phase B (adversarial): force-submit a FORGED proof and a REPLAYED proof
//     using the footprint borrowed from Phase A's valid simulation, so each
//     lands on-chain as a committed, REVERTED transaction:
//       forged -> Error(Contract,#10) ProofInvalid   (pairing check fails)
//       replay -> Error(Contract,#9)  StaleStateRoot  (root already advanced)
//
// Unlike the CLI/UI (which simulate and abort at pre-flight), these adversarial
// rejections are real explorer-visible transactions.
//
// Usage:
//   node app/scripts/sdk/drive.mjs                       # provision fresh + drive
//   node app/scripts/sdk/drive.mjs demo-config.json .keys.json   # drive existing
import fs from "fs";
import {
  S, server, submitAuto, submitWithFootprint, invoke, read,
  scBytes, scBytesN, scU64, scAddr, explorerTx, explorerC,
} from "./chain.mjs";
import {
  proveSeq, getVkHex, makeKeys, fundKeys, deployStablecoin,
  trustline, deployWarrant, configureWarrant, ORACLE,
} from "./provision.mjs";
import { publicToHex } from "./encode.mjs";

const COMMIT = "2e3da43f5d59ed1757ae427481b609988aca187b7075f43733225a7590893a87";
const GENESIS = "45be8d721eb60367b8485489cb4668c6690bc8571750ade6ba195e97cba264f1";
const FUND = "100000";
const SETTLE = 50n;

const hx = (u8) => (u8 == null ? null : Buffer.from(u8).toString("hex"));
const dec2hex32 = (d) => BigInt(d).toString(16).padStart(64, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readState(CID, TOKEN, recipient) {
  const root = hx((await read(CID, "current_state_root")).value);
  const cbal = (await read(TOKEN, "balance", [scAddr(CID)])).value?.toString();
  const rbal = (await read(TOKEN, "balance", [scAddr(recipient)])).value?.toString();
  return { root, cbal, rbal };
}

// Read-replica lag means a balance/root read right after a confirmed tx can be
// stale; poll until the expected state appears (or give up and return last seen).
async function waitForState(CID, TOKEN, recipient, pred, tries = 20) {
  let s;
  for (let i = 0; i < tries; i++) { s = await readState(CID, TOKEN, recipient); if (pred(s)) return s; await sleep(2000); }
  return s;
}

// Pull the contract-error reason out of a confirmed-FAILED tx. The RPC returns
// diagnosticEventsXdr either as base64 strings or already-parsed xdr objects.
async function failReason(hash) {
  for (let i = 0; i < 8; i++) {
    const t = await server.getTransaction(hash);
    if (t.status === "FAILED") {
      for (const d of t.diagnosticEventsXdr || []) {
        let ev;
        try { ev = typeof d === "string" ? S.xdr.DiagnosticEvent.fromXDR(d, "base64") : d; } catch { continue; }
        try {
          const v0 = ev.event().body().v0();
          const topics = v0.topics().map((x) => { try { return S.scValToNative(x); } catch { return x.switch().name; } });
          if (String(topics[0]) === "error") {
            let data; try { data = S.scValToNative(v0.data()); } catch { data = v0.data().switch?.().name; }
            return JSON.stringify({ topics, data }, (k, v) => (typeof v === "bigint" ? v.toString() : v));
          }
        } catch { /* skip */ }
      }
      return "FAILED (no error diagnostic)";
    }
    await sleep(1200);
  }
  return "FAILED (unresolved)";
}

// ---- provision fresh, or load an existing deployment ----
let cfg, submitter;
if (process.argv[2] && process.argv[3]) {
  cfg = JSON.parse(fs.readFileSync(process.argv[2]));
  submitter = S.Keypair.fromSecret(JSON.parse(fs.readFileSync(process.argv[3])).admin);
  console.log("== using existing deployment ==");
} else {
  console.log("== provisioning a fresh contract on testnet ==");
  const keys = makeKeys();
  console.log("admin:", keys.admin.publicKey());
  await fundKeys(keys);
  const { asset, tokenId } = await deployStablecoin(keys.admin);
  await trustline(keys.recipient, asset);
  const vkHex = await getVkHex();
  const warrantId = await deployWarrant(keys.admin);
  await configureWarrant({ admin: keys.admin, recipient: keys.recipient, warrantId, tokenId, commitmentHex: COMMIT, genesisRootHex: GENESIS, vkHex, fundAmount: FUND });
  cfg = { contractId: warrantId, token: tokenId, recipient: keys.recipient.publicKey(), price: ORACLE.price, timestamp: ORACLE.timestamp, signatureHex: ORACLE.signatureHex };
  submitter = keys.admin;
}
const CID = cfg.contractId, TOKEN = cfg.token, RECIP = cfg.recipient;
console.log("contract :", explorerC(CID));
console.log("submitter:", submitter.publicKey(), "\n");

const settleOp = (proofHex, publicHex) =>
  invoke(CID, "settle_with_price", [
    scBytes(proofHex), scBytes(publicHex),
    scU64(cfg.price), scU64(cfg.timestamp), scBytesN(cfg.signatureHex),
  ]);

// ---------------------------------------------------------------------------
const N_SETTLE = Number(process.env.N_SETTLE || 3);
console.log(`Phase A — ${N_SETTLE} CHAINED COMPLIANT settlements (each must SUCCEED and extend the root)`);
const start = await waitForState(CID, TOKEN, RECIP, (s) => s.cbal === FUND);
console.log(`  start : root=${start.root.slice(0, 16)}… custody=${start.cbal} recipient=${start.rbal}`);

let v, okRes;
let prev = start;
let chainOk = true;
for (let i = 1; i <= N_SETTLE; i++) {
  console.log(`  proving settlement #${i} with snarkjs…`);
  v = await proveSeq(i);
  const nextRootHex = dec2hex32(v.publicSignals[2]);
  // sanity: this settlement must extend the current on-chain root
  if (dec2hex32(v.publicSignals[1]) !== prev.root) {
    console.log(`    ❌ settlement #${i} prevRoot does not match on-chain root`); chainOk = false; break;
  }
  okRes = await submitAuto(settleOp(v.proofHex, v.publicHex), submitter, `compliant settle #${i}`);
  const after = await waitForState(CID, TOKEN, RECIP,
    (s) => s.root === nextRootHex && BigInt(s.cbal) === BigInt(prev.cbal) - SETTLE);
  const moved = after.root === nextRootHex &&
    BigInt(prev.cbal) - BigInt(after.cbal) === SETTLE &&
    BigInt(after.rbal) - BigInt(prev.rbal) === SETTLE;
  chainOk = chainOk && moved;
  console.log(`  #${i} ✅ ${explorerTx(okRes.hash)}`);
  console.log(`     root ${prev.root.slice(0, 12)}…->${after.root.slice(0, 12)}…  custody ${prev.cbal}->${after.cbal}  recipient ${prev.rbal}->${after.rbal}  ${moved ? "OK" : "MISMATCH ❌"}`);
  prev = after;
}
const totalMoved = BigInt(start.cbal) - BigInt(prev.cbal);
console.log(`  ${N_SETTLE} settlements chained, moved ${totalMoved} total: ${chainOk && totalMoved === SETTLE * BigInt(N_SETTLE) ? "VERIFIED ✅" : "MISMATCH ❌"}\n`);

// Borrow the last valid simulation's footprint for the adversarial submissions.
const sorobanB64 = okRes.sim.transactionData.build().toXDR("base64");
const minResourceFee = okRes.sim.minResourceFee;
const after = prev;

// ---------------------------------------------------------------------------
console.log("Phase B — ADVERSARIAL settlements (must land as REVERTED txs)");

// FORGED: present the last real proof but lie about which state it extends. Claim
// prevStateRoot = current on-chain root (passes the staleness check) while the
// proof actually attests a different transition. The pairing then fails => ProofInvalid #10.
const forgedSignals = [...v.publicSignals];
forgedSignals[1] = v.publicSignals[2]; // prev := current root
forgedSignals[2] = "12345";            // a next root the proof does not attest
const forged = await submitWithFootprint(settleOp(v.proofHex, publicToHex(forgedSignals)), submitter, sorobanB64, minResourceFee, "forged");
console.log(`  FORGED ${forged.status === "FAILED" ? "✅ REVERTED" : "❌ " + forged.status}: ${explorerTx(forged.hash)}`);
console.log("    reason:", forged.status === "FAILED" ? await failReason(forged.hash) : "(landed unexpectedly)");

// REPLAY: resubmit the last settlement's exact proof+signals; its prevStateRoot
// was already consumed and the root has advanced => StaleStateRoot #9.
const replay = await submitWithFootprint(settleOp(v.proofHex, v.publicHex), submitter, sorobanB64, minResourceFee, "replay");
console.log(`  REPLAY ${replay.status === "FAILED" ? "✅ REVERTED" : "❌ " + replay.status}: ${explorerTx(replay.hash)}`);
console.log("    reason:", replay.status === "FAILED" ? await failReason(replay.hash) : "(landed unexpectedly)");

const end = await waitForState(CID, TOKEN, RECIP, () => true, 1);
const untouched = end.root === after.root && end.cbal === after.cbal && end.rbal === after.rbal;
console.log(`  custody=${end.cbal} recipient=${end.rbal} root=${end.root.slice(0, 16)}…`);
console.log(`  adversarial txs moved nothing: ${untouched ? "VERIFIED ✅" : "STATE CHANGED ❌"}`);

console.log("\n== SUMMARY (all real testnet transactions) ==");
console.log("compliant SUCCESS:", explorerTx(okRes.hash));
console.log("forged    REVERT :", explorerTx(forged.hash), `(${forged.status}, ProofInvalid #10)`);
console.log("replay    REVERT :", explorerTx(replay.hash), `(${replay.status}, StaleStateRoot #9)`);
