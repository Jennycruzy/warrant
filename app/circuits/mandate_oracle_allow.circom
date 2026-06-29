pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component hashers[depth];
    signal left[depth];
    signal right[depth];
    signal cur[depth + 1];
    cur[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;
        left[i] <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        cur[i + 1] <== hashers[i].out;
    }

    root <== cur[depth];
}

// WARRANT mandate predicate with a committed recipient allowlist and a public,
// oracle-authenticated price mark. The contract authenticates the mark before
// verifying the proof; the circuit uses that public price to derive equity.
template MandateOracleAllow(depth) {
    // ---- public inputs ----
    signal input policyCommitment;
    signal input prevStateRoot;
    signal input nextStateRoot;
    signal input amount;
    signal input recipient;
    signal input price;

    // ---- private mandate parameters ----
    signal input maxPerTx;
    signal input maxPosition;
    signal input drawdownLimit;
    signal input allowlistRoot;

    // ---- private book state ----
    signal input prevPosition;
    signal input peakEquity;

    // ---- private Merkle membership witness ----
    signal input pathElements[depth];
    signal input pathIndices[depth];

    component cmt = Poseidon(4);
    cmt.inputs[0] <== maxPerTx;
    cmt.inputs[1] <== maxPosition;
    cmt.inputs[2] <== drawdownLimit;
    cmt.inputs[3] <== allowlistRoot;
    policyCommitment === cmt.out;

    component priceBits = Num2Bits(64);
    priceBits.in <== price;

    signal currentEquity;
    currentEquity <== prevPosition * price;

    component prev = Poseidon(3);
    prev.inputs[0] <== prevPosition;
    prev.inputs[1] <== peakEquity;
    prev.inputs[2] <== currentEquity;
    prevStateRoot === prev.out;

    component leAmount = LessEqThan(64);
    leAmount.in[0] <== amount;
    leAmount.in[1] <== maxPerTx;
    leAmount.out === 1;

    signal nextPosition;
    nextPosition <== prevPosition + amount;
    component lePosition = LessEqThan(64);
    lePosition.in[0] <== nextPosition;
    lePosition.in[1] <== maxPosition;
    lePosition.out === 1;

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

    signal nextEquity;
    nextEquity <== nextPosition * price;

    // Running high-water mark: the book's peak equity rises to track new highs.
    // peakEquity stays fixed while position grows (currentEquity == peakEquity on
    // the way up, so drawdown is 0), which is what lets the SAME contract chain
    // many compliant settlements instead of exactly one. Drawdown protection still
    // bites whenever equity FALLS below the mark (e.g. a lower oracle price).
    component geNext = GreaterEqThan(64);
    geNext.in[0] <== nextEquity;
    geNext.in[1] <== peakEquity;
    signal nextPeak;
    nextPeak <== peakEquity + geNext.out * (nextEquity - peakEquity);

    component next = Poseidon(3);
    next.inputs[0] <== nextPosition;
    next.inputs[1] <== nextPeak;
    next.inputs[2] <== nextEquity;
    nextStateRoot === next.out;

    component mp = MerkleProof(depth);
    mp.leaf <== recipient;
    for (var i = 0; i < depth; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }
    allowlistRoot === mp.root;

    component rb = Num2Bits(248);
    rb.in <== recipient;
}

component main {public [policyCommitment, prevStateRoot, nextStateRoot, amount, recipient, price]} = MandateOracleAllow(3);
