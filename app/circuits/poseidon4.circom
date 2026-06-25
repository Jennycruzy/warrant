pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";

// Helper to compute Poseidon(4) off-chain over the SAME field/constants the
// mandate circuit uses (Merkle hashing / commitment derivation).
template Poseidon4T() {
    signal input in[4];
    signal output out;
    component h = Poseidon(4);
    for (var i = 0; i < 4; i++) { h.inputs[i] <== in[i]; }
    out <== h.out;
}

component main = Poseidon4T();
