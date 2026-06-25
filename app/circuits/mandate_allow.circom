pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

// Verify a Poseidon Merkle membership proof of `leaf` against a computed root.
template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];  // 0 = current node is left child, 1 = right
    signal output root;

    component hashers[depth];
    signal left[depth];
    signal right[depth];
    signal cur[depth + 1];
    cur[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // pathIndices[i] must be boolean
        pathIndices[i] * (pathIndices[i] - 1) === 0;
        // order the pair according to the path bit
        left[i]  <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        cur[i + 1] <== hashers[i].out;
    }
    root <== cur[depth];
}

// WARRANT mandate predicate with a private recipient allowlist (Phase 5).
//
// The allowlist root is folded into the policy commitment, so the set of
// permitted recipients is itself private and bound to the same commitment as
// the limits. The recipient public input must be a Merkle leaf under that root.
template MandateAllow(depth) {
    // ---- public inputs (unchanged: 5) ----
    signal input policyCommitment;
    signal input prevStateRoot;
    signal input nextStateRoot;
    signal input amount;
    signal input recipient;

    // ---- private mandate parameters ----
    signal input maxPerTx;
    signal input maxPosition;
    signal input drawdownLimit;
    signal input allowlistRoot;

    // ---- private book state ----
    signal input prevPosition;
    signal input peakEquity;
    signal input currentEquity;

    // ---- private Merkle membership witness ----
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // (1) commitment now binds the limits AND the allowlist root
    component cmt = Poseidon(4);
    cmt.inputs[0] <== maxPerTx;
    cmt.inputs[1] <== maxPosition;
    cmt.inputs[2] <== drawdownLimit;
    cmt.inputs[3] <== allowlistRoot;
    policyCommitment === cmt.out;

    // (2) prior book state matches prevStateRoot
    component prev = Poseidon(3);
    prev.inputs[0] <== prevPosition;
    prev.inputs[1] <== peakEquity;
    prev.inputs[2] <== currentEquity;
    prevStateRoot === prev.out;

    // (3) amount <= maxPerTx
    component leAmount = LessEqThan(64);
    leAmount.in[0] <== amount;
    leAmount.in[1] <== maxPerTx;
    leAmount.out === 1;

    // (4) nextPosition = prevPosition + amount, nextPosition <= maxPosition
    signal nextPosition;
    nextPosition <== prevPosition + amount;
    component lePosition = LessEqThan(64);
    lePosition.in[0] <== nextPosition;
    lePosition.in[1] <== maxPosition;
    lePosition.out === 1;

    // (5) currentEquity <= peakEquity and peakEquity - currentEquity <= drawdownLimit
    component leEquity = LessEqThan(64);
    leEquity.in[0] <== currentEquity;
    leEquity.in[1] <== peakEquity;
    leEquity.out === 1;
    signal drawdown;
    drawdown <== peakEquity - currentEquity;
    component leDrawdown = LessEqThan(64);
    leDrawdown.in[0] <== drawdown;
    leDrawdown.in[1] <== drawdownLimit;
    leDrawdown.out === 1;

    // (6) new book state matches nextStateRoot
    component next = Poseidon(3);
    next.inputs[0] <== nextPosition;
    next.inputs[1] <== peakEquity;
    next.inputs[2] <== currentEquity;
    nextStateRoot === next.out;

    // (7) recipient is a member of the committed allowlist
    component mp = MerkleProof(depth);
    mp.leaf <== recipient;
    for (var i = 0; i < depth; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }
    allowlistRoot === mp.root;

    // recipient range-bound to a well-formed field-packed value
    component rb = Num2Bits(248);
    rb.in <== recipient;
}

component main {public [policyCommitment, prevStateRoot, nextStateRoot, amount, recipient]} = MandateAllow(3);
