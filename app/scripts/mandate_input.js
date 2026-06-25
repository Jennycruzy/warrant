// Build a full mandate.circom input.json from a scenario, deriving the public
// commitment and state roots with the field-consistent Poseidon helper.
//
// Usage:
//   node mandate_input.js <maxPerTx> <maxPosition> <drawdownLimit> \
//                         <prevPosition> <peakEquity> <currentEquity> \
//                         <amount> <recipient> <outFile>
const fs = require("fs");
const { poseidon3 } = require("./poseidon");

async function main() {
  const a = process.argv.slice(2);
  if (a.length !== 9) {
    console.error("expected 9 arguments, got " + a.length);
    process.exit(1);
  }
  const [maxPerTx, maxPosition, drawdownLimit, prevPosition, peakEquity, currentEquity, amount, recipient, outFile] = a;

  const policyCommitment = await poseidon3(maxPerTx, maxPosition, drawdownLimit);
  const prevStateRoot = await poseidon3(prevPosition, peakEquity, currentEquity);
  const nextPosition = (BigInt(prevPosition) + BigInt(amount)).toString();
  const nextStateRoot = await poseidon3(nextPosition, peakEquity, currentEquity);

  const input = {
    policyCommitment, prevStateRoot, nextStateRoot, amount, recipient,
    maxPerTx, maxPosition, drawdownLimit,
    prevPosition, peakEquity, currentEquity,
  };
  fs.writeFileSync(outFile, JSON.stringify(input, null, 2));
  console.log("wrote " + outFile);
  console.log("  policyCommitment = " + policyCommitment);
  console.log("  prevStateRoot    = " + prevStateRoot);
  console.log("  nextStateRoot    = " + nextStateRoot);
  console.log("  nextPosition     = " + nextPosition);
}

main().catch((e) => { console.error(e); process.exit(1); });
