import * as StellarSdk from "@stellar/stellar-sdk";
import { hexToBytes } from "./snarkHex.js";

const rpcNamespace = StellarSdk.SorobanRpc || StellarSdk.rpc;
const assembleTransaction = rpcNamespace.assembleTransaction || StellarSdk.assembleTransaction;

export const DEFAULT_NETWORK = "Test SDF Network ; September 2015";
export const DEFAULT_RPC = "https://soroban-testnet.stellar.org";

// Warrant contract error codes -> names (must match contracts/warrant/src/lib.rs).
export const CONTRACT_ERRORS = {
  1: "AlreadyInitialized", 2: "NotInitialized", 3: "MalformedVerifyingKey",
  4: "VerificationKeyNotSet", 5: "MalformedProof", 6: "MalformedPublicSignals",
  7: "WrongPublicSignalCount", 8: "CommitmentMismatch", 9: "StaleStateRoot",
  10: "ProofInvalid", 11: "RecipientNotRegistered", 12: "AmountOutOfRange",
  13: "RecipientIdOutOfRange", 14: "OracleKeyNotSet", 15: "PriceMismatch",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serverFor(rpcUrl) {
  return new rpcNamespace.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
}

function keypairFromSecret(secret) {
  if (!secret || secret.includes("REPLACE_WITH")) throw new Error("Set VITE_SOURCE_SECRET to a funded testnet secret key.");
  return StellarSdk.Keypair.fromSecret(secret.trim());
}

function scBytes(hex) {
  return StellarSdk.xdr.ScVal.scvBytes(hexToBytes(hex));
}

function scBytesN(hex) {
  return StellarSdk.nativeToScVal(hexToBytes(hex), { type: "bytes" });
}

function scU64(value) {
  return StellarSdk.nativeToScVal(BigInt(value), { type: "u64" });
}

function settleArgs(opts) {
  return [
    scBytes(opts.proofHex),
    scBytes(opts.publicHex),
    scU64(opts.price),
    scU64(opts.timestamp),
    scBytesN(opts.signatureHex),
  ];
}

function settleOp(contractId, args) {
  return StellarSdk.Operation.invokeContractFunction({ contract: contractId, function: "settle_with_price", args });
}

// Pull the contract-error reason out of a confirmed-FAILED Soroban tx's diagnostics.
// The RPC returns diagnosticEventsXdr as base64 strings or already-parsed xdr objects.
function errorReason(tx) {
  for (const d of tx.diagnosticEventsXdr || []) {
    let ev;
    try { ev = typeof d === "string" ? StellarSdk.xdr.DiagnosticEvent.fromXDR(d, "base64") : d; } catch { continue; }
    let topics;
    try { topics = ev.event().body().v0().topics().map((x) => { try { return StellarSdk.scValToNative(x); } catch { return null; } }); } catch { continue; }
    if (!topics || String(topics[0]) !== "error") continue;
    const errObj = topics[1];
    const code = errObj && typeof errObj === "object" ? errObj.code : undefined;
    if (typeof code === "number") return { code, name: CONTRACT_ERRORS[code] };
  }
  return { code: undefined, name: undefined };
}

async function waitForTx(server, hash, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tx = await server.getTransaction(hash);
    if (tx.status !== "NOT_FOUND") return tx;
    await sleep(2000);
  }
  return { status: "NOT_FOUND" };
}

export async function readContractState({ rpcUrl, contractId }) {
  if (!contractId) return {};
  const server = serverFor(rpcUrl);
  async function simulate(fn) {
    const kp = StellarSdk.Keypair.random();
    const account = new StellarSdk.Account(kp.publicKey(), "0");
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: DEFAULT_NETWORK,
    })
      .addOperation(StellarSdk.Operation.invokeContractFunction({ contract: contractId, function: fn, args: [] }))
      .setTimeout(30)
      .build();
    const res = await server.simulateTransaction(tx);
    return res.result?.retval ? StellarSdk.scValToNative(res.result.retval) : "";
  }
  const [root, commitment] = await Promise.all([simulate("current_state_root"), simulate("policy_commitment")]);
  return { root: String(root), commitment: String(commitment) };
}

// Compliant path: simulate (the pre-flight gate), submit, confirm SUCCESS, and return
// the hash plus the BORROWED footprint (Soroban data + min fee) from the valid
// simulation. The adversarial calls reuse that footprint to force-submit failing txs.
export async function settleWithPrice(opts) {
  const server = serverFor(opts.rpcUrl);
  const source = keypairFromSecret(opts.sourceSecret);

  const account = await server.getAccount(source.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, { fee: "1000000", networkPassphrase: opts.networkPassphrase })
    .addOperation(settleOp(opts.contractId, settleArgs(opts)))
    .setTimeout(120)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (rpcNamespace.Api?.isSimulationError?.(simulated) || simulated.error) {
    const err = simulated.error || simulated;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  }

  const footprint = {
    sorobanData: simulated.transactionData.build().toXDR("base64"),
    minResourceFee: simulated.minResourceFee,
  };

  const prepared = assembleTransaction(tx, simulated).build();
  prepared.sign(source);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(JSON.stringify(sent.errorResult || sent));

  const result = await waitForTx(server, sent.hash);
  if (result.status !== "SUCCESS") {
    const r = errorReason(result);
    throw new Error(`settlement did not confirm (${result.status}${r.name ? `, ${r.name}` : ""})`);
  }
  return { hash: sent.hash, status: "SUCCESS", footprint };
}

// Adversarial path: build a settle tx with a BORROWED footprint from a prior valid
// simulation and submit it WITHOUT a pre-flight gate, so a deliberately invalid
// settlement still lands on-chain and the contract reverts. Returns the real hash,
// the on-chain status (expected "FAILED"), and the decoded revert reason.
export async function settleWithFootprint(opts) {
  if (!opts.footprint?.sorobanData) throw new Error("no borrowed footprint — run a compliant settlement first");
  const server = serverFor(opts.rpcUrl);
  const source = keypairFromSecret(opts.sourceSecret);
  const fee = (BigInt(opts.footprint.minResourceFee) + 5_000_000n).toString();
  const args = settleArgs(opts);

  let lastHash;
  for (let round = 0; round < 4; round++) {
    const account = await server.getAccount(source.publicKey());
    const tx = new StellarSdk.TransactionBuilder(account, { fee, networkPassphrase: opts.networkPassphrase })
      .addOperation(settleOp(opts.contractId, args))
      .setSorobanData(opts.footprint.sorobanData)
      .setTimeout(120)
      .build();
    tx.sign(source);

    const sent = await server.sendTransaction(tx);
    if (sent.status === "TRY_AGAIN_LATER") { await sleep(3000); continue; }
    if (sent.status === "ERROR") {
      const name = sent.errorResult?.result?.()?.switch?.()?.name;
      if (name === "txBadSeq") { await sleep(2000); continue; }
      throw new Error(JSON.stringify(sent.errorResult || sent));
    }

    lastHash = sent.hash;
    const result = await waitForTx(server, sent.hash);
    if (result.status === "NOT_FOUND") continue; // dropped from the mempool: resubmit
    const reason = result.status === "FAILED" ? errorReason(result) : { code: undefined, name: undefined };
    return { hash: sent.hash, status: result.status, reason };
  }
  return { hash: lastHash, status: "DROPPED", reason: { code: undefined, name: undefined } };
}
