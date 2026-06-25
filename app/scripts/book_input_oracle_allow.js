// Build a mandate_oracle_allow.circom input.json from the private book, a
// private allowlist, and a public oracle-authenticated price.
//
// Usage: node book_input_oracle_allow.js <stateFile> <recipientId> <amount> <price> <outFile>
const fs = require("fs");
const { poseidon3, poseidon4 } = require("./poseidon");
const { buildTree, proofForIndex } = require("./allowlist");

async function main() {
  const [stateFile, recipientId, amount, price, outFile] = process.argv.slice(2);
  if (!stateFile || recipientId === undefined || amount === undefined || price === undefined || !outFile) {
    console.error("usage: node book_input_oracle_allow.js <stateFile> <recipientId> <amount> <price> <outFile>");
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const { maxPerTx, maxPosition, drawdownLimit } = state.mandate;
  const { position, peakEquity } = state.book;
  const { depth, leaves } = state.allowlist;

  const tree = await buildTree(leaves, depth);
  const allowlistRoot = tree.root;
  const idx = leaves.map(String).indexOf(String(recipientId));
  const member = idx >= 0;
  const { pathElements, pathIndices } = proofForIndex(tree, member ? idx : 0);

  const currentEquity = (BigInt(position) * BigInt(price)).toString();
  const nextPosition = (BigInt(position) + BigInt(amount)).toString();
  const nextEquity = (BigInt(nextPosition) * BigInt(price)).toString();

  const policyCommitment = await poseidon4(maxPerTx, maxPosition, drawdownLimit, allowlistRoot);
  const prevStateRoot = await poseidon3(position, peakEquity, currentEquity);
  const nextStateRoot = await poseidon3(nextPosition, peakEquity, nextEquity);

  const input = {
    policyCommitment, prevStateRoot, nextStateRoot,
    amount: String(amount), recipient: String(recipientId), price: String(price),
    maxPerTx, maxPosition, drawdownLimit, allowlistRoot,
    prevPosition: position, peakEquity,
    pathElements, pathIndices,
  };
  fs.writeFileSync(outFile, JSON.stringify(input, null, 2));

  const hex = (d) => BigInt(d).toString(16).padStart(64, "0");
  const meta = {
    member,
    commitmentHex: hex(policyCommitment),
    prevRootHex: hex(prevStateRoot),
    nextRootHex: hex(nextStateRoot),
    allowlistRoot,
    currentEquity,
    nextEquity,
    nextPosition,
    price: String(price),
  };
  fs.writeFileSync(outFile + ".meta.json", JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta));
}

main().catch((e) => { console.error(e); process.exit(1); });
