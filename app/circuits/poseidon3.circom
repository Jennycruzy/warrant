pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";

// Helper used off-chain to compute Poseidon(3) over the SAME field and with the
// SAME constants the mandate circuit uses, so the prover can derive the exact
// policyCommitment / state-root values it must supply as public inputs.
template Poseidon3() {
    signal input in[3];
    signal output out;
    component h = Poseidon(3);
    for (var i = 0; i < 3; i++) {
        h.inputs[i] <== in[i];
    }
    out <== h.out;
}

component main = Poseidon3();
