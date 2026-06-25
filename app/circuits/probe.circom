pragma circom 2.0.0;

// Phase 1 arity probe: two PRIVATE inputs (a, b) and two PUBLIC inputs
// (sum, product). Its sole purpose is to prove the full front-half pipeline
// works on our own from-scratch circuit AND that the reference encoder +
// on-chain verifier handle more than one public input.
template Probe() {
    signal input a;        // private
    signal input b;        // private
    signal input sum;      // public
    signal input product;  // public

    sum === a + b;
    product === a * b;
}

component main {public [sum, product]} = Probe();
