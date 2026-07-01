// Poseidon Merkle allowlist over BLS12-381.
//
// Fixed-depth binary tree. Leaves are recipient ids (field elements); empty
// slots are 0. Internal nodes are Poseidon(left, right). Provides the root and,
// for any member leaf, the (pathElements, pathIndices) a prover needs.
const { poseidon2, poseidon3 } = require("./poseidon");

// Build the full tree. `leaves` are decimal strings; padded to 2^depth with "0".
async function buildTree(leaves, depth) {
  const size = 1 << depth;
  if (leaves.length > size) {
    throw new Error(`too many leaves (${leaves.length}) for depth ${depth} (max ${size})`);
  }
  const level0 = leaves.map(String).concat(Array(size - leaves.length).fill("0"));
  const levels = [level0];
  for (let d = 0; d < depth; d++) {
    const prev = levels[d];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(await poseidon2(prev[i], prev[i + 1]));
    }
    levels.push(next);
  }
  return { levels, root: levels[depth][0], depth };
}

// Return { pathElements, pathIndices } proving leaf at `index` is in the tree.
// pathIndices[d] = 0 if the current node is a left child at level d, else 1.
function proofForIndex(tree, index) {
  const pathElements = [];
  const pathIndices = [];
  let idx = index;
  for (let d = 0; d < tree.depth; d++) {
    const isRight = idx & 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    pathElements.push(tree.levels[d][siblingIdx]);
    pathIndices.push(isRight ? "1" : "0");
    idx >>= 1;
  }
  return { pathElements, pathIndices };
}

async function addressLeaf(identity) {
  return poseidon3(identity.recipientType, identity.recipientHi, identity.recipientLo);
}

module.exports = { buildTree, proofForIndex, addressLeaf };
