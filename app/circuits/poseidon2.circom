pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";

// Helper to compute Poseidon(2) off-chain over the SAME field/constants the
// mandate circuit uses (Merkle hashing / commitment derivation).
template Poseidon2T() {
    signal input in[2];
    signal output out;
    component h = Poseidon(2);
    for (var i = 0; i < 2; i++) { h.inputs[i] <== in[i]; }
    out <== h.out;
}

component main = Poseidon2T();
