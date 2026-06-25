pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

// WARRANT mandate predicate.
//
// Proves that a settlement obeys a private, pre-committed mandate and that it
// extends a private book whose prior state hashes to prevStateRoot, producing a
// new book that hashes to nextStateRoot. Only the commitment, the two roots, the
// amount and the recipient are public; the mandate limits and the book stay private.
template Mandate() {
    // ---- public inputs ----
    signal input policyCommitment;  // Poseidon(maxPerTx, maxPosition, drawdownLimit)
    signal input prevStateRoot;     // Poseidon(prevPosition, peakEquity, currentEquity)
    signal input nextStateRoot;     // Poseidon(nextPosition, peakEquity, currentEquity)
    signal input amount;            // amount to settle this transaction
    signal input recipient;         // recipient (allowlist membership added in Phase 5)

    // ---- private mandate parameters ----
    signal input maxPerTx;
    signal input maxPosition;
    signal input drawdownLimit;

    // ---- private book state ----
    signal input prevPosition;
    signal input peakEquity;
    signal input currentEquity;

    // (1) the mandate parameters must match the public commitment
    component cmt = Poseidon(3);
    cmt.inputs[0] <== maxPerTx;
    cmt.inputs[1] <== maxPosition;
    cmt.inputs[2] <== drawdownLimit;
    policyCommitment === cmt.out;

    // (2) the prior book state must match the public prevStateRoot
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

    // (4) nextPosition = prevPosition + amount, and nextPosition <= maxPosition
    signal nextPosition;
    nextPosition <== prevPosition + amount;
    component lePosition = LessEqThan(64);
    lePosition.in[0] <== nextPosition;
    lePosition.in[1] <== maxPosition;
    lePosition.out === 1;

    // (5) drawdown: currentEquity <= peakEquity (no underflow), and
    //     peakEquity - currentEquity <= drawdownLimit
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

    // (6) the new book state must match the public nextStateRoot
    component next = Poseidon(3);
    next.inputs[0] <== nextPosition;
    next.inputs[1] <== peakEquity;
    next.inputs[2] <== currentEquity;
    nextStateRoot === next.out;

    // recipient is range-bound so it is a well-formed field-packed value.
    component recipientBits = Num2Bits(248);
    recipientBits.in <== recipient;
}

component main {public [policyCommitment, prevStateRoot, nextStateRoot, amount, recipient]} = Mandate();
