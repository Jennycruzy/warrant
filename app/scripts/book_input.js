// Build a mandate.circom input.json from the prover's PERSISTED private book.
//
// The book file is the prover's private state; it must reproduce a prevStateRoot
// that matches the contract's current on-chain root, or the settlement is rejected.
//
// Usage: node book_input.js <bookFile> <amount> <recipientId> <outFile>
const fs = require("fs");
const { poseidon3 } = require("./poseidon");

async function main() {
  const [bookFile, amount, recipientId, outFile] = process.argv.slice(2);
  if (!bookFile || amount === undefined || recipientId === undefined || !outFile) {
    console.error("usage: node book_input.js <bookFile> <amount> <recipientId> <outFile>");
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(bookFile, "utf8"));
  const { maxPerTx, maxPosition, drawdownLimit } = state.mandate;
  const { position, peakEquity, currentEquity } = state.book;

  const policyCommitment = await poseidon3(maxPerTx, maxPosition, drawdownLimit);
  const prevStateRoot = await poseidon3(position, peakEquity, currentEquity);
  const nextPosition = (BigInt(position) + BigInt(amount)).toString();
  const nextStateRoot = await poseidon3(nextPosition, peakEquity, currentEquity);

  const input = {
    policyCommitment, prevStateRoot, nextStateRoot,
    amount: String(amount), recipient: String(recipientId),
    maxPerTx, maxPosition, drawdownLimit,
    prevPosition: position, peakEquity, currentEquity,
  };
  fs.writeFileSync(outFile, JSON.stringify(input, null, 2));

  // Emit the values the orchestrator needs (hex form for on-chain comparison).
  const hex = (d) => BigInt(d).toString(16).padStart(64, "0");
  const out = {
    commitmentHex: hex(policyCommitment),
    prevRootHex: hex(prevStateRoot),
    nextRootHex: hex(nextStateRoot),
    nextPosition,
  };
  fs.writeFileSync(outFile + ".meta.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
}

main().catch((e) => { console.error(e); process.exit(1); });
