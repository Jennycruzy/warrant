import { createRequire } from "node:module";
import { addressIdentity } from "./address_identity.mjs";

const require = createRequire(import.meta.url);
const { poseidon3, poseidon4 } = require("./poseidon.js");
const { buildTree, proofForIndex, addressLeaf } = require("./allowlist.js");

const hex32 = (d) => BigInt(d).toString(16).padStart(64, "0");

function requireField(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing ${name}`);
  }
  return String(value);
}

export async function buildAddressControls(config) {
  if (config.recipientBinding !== "address") {
    throw new Error("address control manifest requires recipientBinding=address");
  }
  const mandate = config.mandate || {};
  const maxPerTx = BigInt(requireField(mandate.maxPerTx, "mandate.maxPerTx"));
  const maxPosition = BigInt(requireField(mandate.maxPosition, "mandate.maxPosition"));
  const drawdownLimit = requireField(mandate.drawdownLimit, "mandate.drawdownLimit");
  const startPosition = BigInt(requireField(config.book?.position, "book.position"));
  const startPeak = BigInt(requireField(config.book?.peakEquity, "book.peakEquity"));
  const price = BigInt(requireField(config.price, "price"));
  const depth = Number(config.allowlistDepth || 3);

  const recipients = (config.recipients || []).map((entry, index) => {
    const identity = addressIdentity(entry.address);
    return {
      id: String(entry.id ?? index),
      label: entry.label || entry.address,
      address: entry.address,
      type: Number(identity.recipientType),
      recipientType: identity.recipientType,
      recipientHi: identity.recipientHi,
      recipientLo: identity.recipientLo,
      bytesHex: identity.bytesHex,
    };
  });
  if (recipients.length === 0) {
    throw new Error("address control manifest requires at least one recipient");
  }

  const leaves = [];
  for (const recipient of recipients) {
    leaves.push(await addressLeaf(recipient));
  }
  const tree = await buildTree(leaves, depth);
  const allowlistRoot = tree.root;
  const policyCommitment = await poseidon4(
    maxPerTx.toString(),
    maxPosition.toString(),
    drawdownLimit,
    allowlistRoot
  );
  const commitmentHex = hex32(policyCommitment);
  if (config.commitmentHex && commitmentHex !== String(config.commitmentHex).toLowerCase()) {
    throw new Error(`control commitment ${commitmentHex} does not match config ${config.commitmentHex}`);
  }

  const recipientsWithPaths = recipients.map((recipient, index) => ({
    ...recipient,
    leaf: leaves[index],
    ...proofForIndex(tree, index),
  }));

  const states = [];
  const lastGeneratedPosition = maxPosition + maxPerTx;
  for (let position = startPosition; position <= lastGeneratedPosition; position += 1n) {
    const currentEquity = position * price;
    const peakEquity = currentEquity > startPeak ? currentEquity : startPeak;
    const root = await poseidon3(position.toString(), peakEquity.toString(), currentEquity.toString());
    states.push({
      position: position.toString(),
      peakEquity: peakEquity.toString(),
      currentEquity: currentEquity.toString(),
      root: root.toString(),
      rootHex: hex32(root),
    });
  }

  return {
    version: 1,
    recipientBinding: "address",
    price: price.toString(),
    mandate: {
      maxPerTx: maxPerTx.toString(),
      maxPosition: maxPosition.toString(),
      drawdownLimit,
    },
    amountMin: "1",
    amountMax: maxPerTx.toString(),
    allowlistRoot,
    policyCommitment: policyCommitment.toString(),
    commitmentHex,
    genesisRootHex: states[0].rootHex,
    recipients: recipientsWithPaths,
    states,
  };
}
