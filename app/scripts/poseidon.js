// Field-consistent Poseidon(3) over BLS12-381, computed with the SAME compiled
// circuit (poseidon3.wasm) the mandate circuit uses. This guarantees the values
// the prover supplies as public inputs (policyCommitment, state roots) match what
// the circuit recomputes and constrains — no separate JS hash library is trusted.
const fs = require("fs");
const path = require("path");

const WASM = path.join(__dirname, "..", "build", "poseidon3_js", "poseidon3.wasm");
const builder = require(path.join(__dirname, "..", "build", "poseidon3_js", "witness_calculator.js"));

// Compute Poseidon([a, b, c]) and return the result as a decimal string.
async function poseidon3(a, b, c) {
  const wc = await builder(fs.readFileSync(WASM));
  // calculateWitness returns the full witness vector as bigints;
  // index 0 is the constant 1, index 1 is the circuit's single output.
  const witness = await wc.calculateWitness(
    { in: [String(a), String(b), String(c)] },
    true
  );
  return witness[1].toString();
}

module.exports = { poseidon3 };
