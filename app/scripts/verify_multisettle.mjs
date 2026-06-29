// Local proof that the WARRANT oracle circuit now supports MANY chained
// settlements (not just one). Builds a sequence of compliant settlements from
// the genesis book, proves each with snarkjs, verifies it, and checks the
// state-root chain links (settle N+1's prevRoot == settle N's nextRoot).
//
// No network, no keys, no testnet spend. Run after `bash app/scripts/build_circuit.sh`.
//   node app/scripts/verify_multisettle.mjs [count]
import * as snarkjs from "snarkjs";
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { poseidon3, poseidon4 } = require("./poseidon");
const { buildTree, proofForIndex } = require("./allowlist");

const ROOT = new URL("../..", import.meta.url).pathname;
const WASM = `${ROOT}/app/frontend/public/circuits/mandate_oracle_allow.wasm`;
const ZKEY = `${ROOT}/app/frontend/public/proving/mandate_oracle_allow_final.zkey`;

const book = JSON.parse(fs.readFileSync(`${ROOT}/app/scripts/oracle_book.json`));
const PRICE = 10n, AMOUNT = 50n, RECIPIENT = "0";
const COUNT = Number(process.argv[2] || 5);

async function buildInput(position, peakEquity) {
  const tree = await buildTree(book.allowlist.leaves, book.allowlist.depth);
  const allowlistRoot = tree.root;
  const idx = book.allowlist.leaves.map(String).indexOf(RECIPIENT);
  const { pathElements, pathIndices } = proofForIndex(tree, idx);

  const currentEquity = position * PRICE;
  const nextPosition = position + AMOUNT;
  const nextEquity = nextPosition * PRICE;
  const nextPeak = nextEquity >= peakEquity ? nextEquity : peakEquity;

  const policyCommitment = await poseidon4(book.mandate.maxPerTx, book.mandate.maxPosition, book.mandate.drawdownLimit, allowlistRoot);
  const prevStateRoot = await poseidon3(position.toString(), peakEquity.toString(), currentEquity.toString());
  const nextStateRoot = await poseidon3(nextPosition.toString(), nextPeak.toString(), nextEquity.toString());

  const input = {
    policyCommitment, prevStateRoot, nextStateRoot,
    amount: AMOUNT.toString(), recipient: RECIPIENT, price: PRICE.toString(),
    maxPerTx: book.mandate.maxPerTx, maxPosition: book.mandate.maxPosition,
    drawdownLimit: book.mandate.drawdownLimit, allowlistRoot,
    prevPosition: position.toString(), peakEquity: peakEquity.toString(),
    pathElements, pathIndices,
  };
  return { input, nextPosition, nextPeak, prevStateRoot, nextStateRoot };
}

const vkey = await snarkjs.zKey.exportVerificationKey(ZKEY);
let position = BigInt(book.book.position);
let peak = BigInt(book.book.peakEquity);
let expectedPrev = null;
let allOk = true;

console.log(`Chaining ${COUNT} compliant settlements from genesis (pos=${position}, peak=${peak}, price=${PRICE}, amount=${AMOUNT})\n`);
for (let i = 1; i <= COUNT; i++) {
  const { input, nextPosition, nextPeak, prevStateRoot, nextStateRoot } = await buildInput(position, peak);
  const chained = expectedPrev === null || prevStateRoot === expectedPrev;
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  const pubPrev = publicSignals[1], pubNext = publicSignals[2];
  const boundOk = pubPrev === prevStateRoot && pubNext === nextStateRoot;
  allOk = allOk && ok && chained && boundOk;
  console.log(`settle #${i}: pos ${position}->${nextPosition}  peak ${peak}->${nextPeak}  verify=${ok}  chained=${chained}  root ${prevStateRoot.slice(0, 10)}…->${nextStateRoot.slice(0, 10)}…`);
  position = nextPosition; peak = nextPeak; expectedPrev = nextStateRoot;
}

console.log(`\n${allOk ? "✅ ALL settlements proved, verified, and chained" : "❌ a settlement failed"} — position grew ${book.book.position} -> ${position} (maxPosition ${book.mandate.maxPosition})`);
process.exit(allOk ? 0 : 1);
