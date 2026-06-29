// Generate a deterministic SEQUENCE of chained compliant settlement inputs for
// the UI, so the browser can perform many real settlements without recomputing
// Poseidon client-side. Each settle_NN.input.json extends the previous one's
// state root; manifest.json maps the on-chain prevRoot a viewer will see to the
// input that extends it.
//
//   node app/scripts/gen_sequence.mjs [count]
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { poseidon3, poseidon4 } = require("./poseidon");
const { buildTree, proofForIndex } = require("./allowlist");

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = `${ROOT}/app/frontend/public/seq`;
const book = JSON.parse(fs.readFileSync(`${ROOT}/app/scripts/oracle_book.json`));

const PRICE = 10n, AMOUNT = 50n, RECIPIENT = "0";
const COUNT = Number(process.argv[2] || 12);
const hex = (d) => BigInt(d).toString(16).padStart(64, "0");

fs.mkdirSync(OUT, { recursive: true });

const tree = await buildTree(book.allowlist.leaves, book.allowlist.depth);
const allowlistRoot = tree.root;
const idx = book.allowlist.leaves.map(String).indexOf(RECIPIENT);
const { pathElements, pathIndices } = proofForIndex(tree, idx);
const policyCommitment = await poseidon4(book.mandate.maxPerTx, book.mandate.maxPosition, book.mandate.drawdownLimit, allowlistRoot);

let position = BigInt(book.book.position);
let peak = BigInt(book.book.peakEquity);
const manifest = [];

for (let i = 1; i <= COUNT; i++) {
  const nextPosition = position + AMOUNT;
  if (nextPosition > BigInt(book.mandate.maxPosition)) break; // beyond mandate; stop
  const currentEquity = position * PRICE;
  const nextEquity = nextPosition * PRICE;
  const nextPeak = nextEquity >= peak ? nextEquity : peak;

  const prevStateRoot = await poseidon3(position.toString(), peak.toString(), currentEquity.toString());
  const nextStateRoot = await poseidon3(nextPosition.toString(), nextPeak.toString(), nextEquity.toString());

  const input = {
    policyCommitment, prevStateRoot, nextStateRoot,
    amount: AMOUNT.toString(), recipient: RECIPIENT, price: PRICE.toString(),
    maxPerTx: book.mandate.maxPerTx, maxPosition: book.mandate.maxPosition,
    drawdownLimit: book.mandate.drawdownLimit, allowlistRoot,
    prevPosition: position.toString(), peakEquity: peak.toString(),
    pathElements, pathIndices,
  };
  const file = `seq/settle_${String(i).padStart(2, "0")}.input.json`;
  fs.writeFileSync(`${ROOT}/app/frontend/public/${file}`, JSON.stringify(input, null, 2));
  manifest.push({
    index: i, file, amount: AMOUNT.toString(),
    prevRootHex: hex(prevStateRoot), nextRootHex: hex(nextStateRoot),
    prevPosition: position.toString(), nextPosition: nextPosition.toString(),
  });

  position = nextPosition; peak = nextPeak;
}

fs.writeFileSync(`${ROOT}/app/frontend/public/seq/manifest.json`, JSON.stringify({
  commitmentHex: hex(policyCommitment),
  genesisRootHex: manifest[0].prevRootHex,
  price: PRICE.toString(), amount: AMOUNT.toString(), recipient: RECIPIENT,
  count: manifest.length, settlements: manifest,
}, null, 2));

console.log(`wrote ${manifest.length} chained settlement inputs to app/frontend/public/seq/`);
console.log(`genesis root ${manifest[0].prevRootHex.slice(0, 12)}…  ->  final root ${manifest[manifest.length - 1].nextRootHex.slice(0, 12)}…`);
console.log(`position ${book.book.position} -> ${position} (maxPosition ${book.mandate.maxPosition})`);
