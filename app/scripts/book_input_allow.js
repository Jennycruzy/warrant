// Build a mandate_allow.circom input.json from the prover's private book and the
// private allowlist. Derives the allowlist root, the policy commitment (which
// binds the root), the state roots, and the Merkle membership witness.
//
// If the requested recipient id is NOT in the allowlist, a (wrong) path is still
// emitted so that witness generation RUNS and then FAILS the membership
// assertion — demonstrating that no valid proof can exist for a non-member.
//
// Usage: node book_input_allow.js <stateFile> <recipientId> <amount> <outFile>
const fs = require("fs");
const { poseidon3, poseidon4 } = require("./poseidon");
const { buildTree, proofForIndex } = require("./allowlist");

async function main() {
  const [stateFile, recipientId, amount, outFile] = process.argv.slice(2);
  if (!stateFile || recipientId === undefined || amount === undefined || !outFile) {
    console.error("usage: node book_input_allow.js <stateFile> <recipientId> <amount> <outFile>");
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const { maxPerTx, maxPosition, drawdownLimit } = state.mandate;
  const { position, peakEquity, currentEquity } = state.book;
  const { depth, leaves } = state.allowlist;

  const tree = await buildTree(leaves, depth);
  const allowlistRoot = tree.root;

  const idx = leaves.map(String).indexOf(String(recipientId));
  const member = idx >= 0;
  const { pathElements, pathIndices } = proofForIndex(tree, member ? idx : 0);

  const policyCommitment = await poseidon4(maxPerTx, maxPosition, drawdownLimit, allowlistRoot);
  const prevStateRoot = await poseidon3(position, peakEquity, currentEquity);
  const nextPosition = (BigInt(position) + BigInt(amount)).toString();
  const nextStateRoot = await poseidon3(nextPosition, peakEquity, currentEquity);

  const input = {
    policyCommitment, prevStateRoot, nextStateRoot,
    amount: String(amount), recipient: String(recipientId),
    maxPerTx, maxPosition, drawdownLimit, allowlistRoot,
    prevPosition: position, peakEquity, currentEquity,
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
    nextPosition,
  };
  fs.writeFileSync(outFile + ".meta.json", JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta));
}

main().catch((e) => { console.error(e); process.exit(1); });
