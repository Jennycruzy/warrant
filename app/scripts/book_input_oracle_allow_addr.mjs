// Build a mandate_oracle_allow_addr.circom input.json from the private book, a
// private address allowlist, and a public oracle-authenticated price.
//
// Usage:
//   node book_input_oracle_allow_addr.mjs <stateFile> <recipientStrkey> <amount> <price> <outFile>
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { addressIdentity } from "./address_identity.mjs";

const require = createRequire(import.meta.url);
const { poseidon3, poseidon4 } = require("./poseidon.js");
const { buildTree, proofForIndex, addressLeaf } = require("./allowlist.js");

const hex = (d) => BigInt(d).toString(16).padStart(64, "0");

async function main() {
  const [stateFile, recipientStrkey, amount, price, outFile] = process.argv.slice(2);
  if (!stateFile || !recipientStrkey || amount === undefined || price === undefined || !outFile) {
    console.error("usage: node book_input_oracle_allow_addr.mjs <stateFile> <recipientStrkey> <amount> <price> <outFile>");
    process.exit(1);
  }

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const { maxPerTx, maxPosition, drawdownLimit } = state.mandate;
  const { position, peakEquity } = state.book;
  const { depth, recipients } = state.allowlist;
  if (!Array.isArray(recipients)) {
    throw new Error("address-bound inputs require state.allowlist.recipients");
  }

  const entries = recipients.map((entry) => {
    const address = typeof entry === "string" ? entry : entry.address;
    if (!address) {
      throw new Error("allowlist recipient entries must be strkeys or {address}");
    }
    return { address, identity: addressIdentity(address) };
  });
  const leaves = [];
  for (const entry of entries) {
    leaves.push(await addressLeaf(entry.identity));
  }
  const tree = await buildTree(leaves, depth);
  const allowlistRoot = tree.root;

  const recipient = addressIdentity(recipientStrkey);
  const recipientLeaf = await addressLeaf(recipient);
  const idx = leaves.map(String).indexOf(String(recipientLeaf));
  const member = idx >= 0;
  const { pathElements, pathIndices } = proofForIndex(tree, member ? idx : 0);

  const currentEquity = (BigInt(position) * BigInt(price)).toString();
  const nextPosition = (BigInt(position) + BigInt(amount)).toString();
  const nextEquity = (BigInt(nextPosition) * BigInt(price)).toString();
  const nextPeak = (BigInt(nextEquity) >= BigInt(peakEquity)
    ? BigInt(nextEquity) : BigInt(peakEquity)).toString();

  const policyCommitment = await poseidon4(maxPerTx, maxPosition, drawdownLimit, allowlistRoot);
  const prevStateRoot = await poseidon3(position, peakEquity, currentEquity);
  const nextStateRoot = await poseidon3(nextPosition, nextPeak, nextEquity);

  const input = {
    policyCommitment,
    prevStateRoot,
    nextStateRoot,
    amount: String(amount),
    recipientType: recipient.recipientType,
    recipientHi: recipient.recipientHi,
    recipientLo: recipient.recipientLo,
    price: String(price),
    maxPerTx,
    maxPosition,
    drawdownLimit,
    allowlistRoot,
    prevPosition: position,
    peakEquity,
    pathElements,
    pathIndices,
  };
  await writeFile(outFile, JSON.stringify(input, null, 2));

  const meta = {
    member,
    recipient: recipientStrkey,
    recipientType: recipient.recipientType,
    recipientBytesHex: recipient.bytesHex,
    recipientHi: recipient.recipientHi,
    recipientLo: recipient.recipientLo,
    recipientLeaf,
    commitmentHex: hex(policyCommitment),
    prevRootHex: hex(prevStateRoot),
    nextRootHex: hex(nextStateRoot),
    allowlistRoot,
    currentEquity,
    nextEquity,
    nextPosition,
    nextPeak,
    price: String(price),
  };
  await writeFile(`${outFile}.meta.json`, JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
