// Field-consistent Poseidon over BLS12-381, computed with the SAME compiled
// circuits the mandate circuit uses (poseidon2/3/4.wasm). This guarantees every
// value the prover derives off-chain (commitment, state roots, Merkle nodes)
// matches what the circuit recomputes and constrains — no separate JS hash
// library is trusted.
const fs = require("fs");
const path = require("path");

const cache = {};

async function poseidon(arity, inputs) {
  if (inputs.length !== arity) {
    throw new Error(`poseidon(${arity}) expects ${arity} inputs, got ${inputs.length}`);
  }
  if (!cache[arity]) {
    const dir = path.join(__dirname, "..", "build", `poseidon${arity}_js`);
    const wasm = path.join(dir, `poseidon${arity}.wasm`);
    const builder = require(path.join(dir, "witness_calculator.js"));
    cache[arity] = await builder(fs.readFileSync(wasm));
  }
  const witness = await cache[arity].calculateWitness(
    { in: inputs.map((x) => String(x)) },
    true
  );
  // index 0 is the constant 1, index 1 is the circuit's single output.
  return witness[1].toString();
}

const poseidon2 = (a, b) => poseidon(2, [a, b]);
const poseidon3 = (a, b, c) => poseidon(3, [a, b, c]);
const poseidon4 = (a, b, c, d) => poseidon(4, [a, b, c, d]);

module.exports = { poseidon, poseidon2, poseidon3, poseidon4 };
