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

// Contract getters return BytesN<32>; render raw bytes as hex.
function bytesToHex(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  const bytes = v instanceof Uint8Array
    ? v
    : ArrayBuffer.isView(v)
      ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
      : Uint8Array.from(v);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
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

// Read-only simulate of a contract getter (no signing, no account needed).
async function simulateGetter(server, contractId, fn, args = []) {
  const kp = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(kp.publicKey(), "0");
  const tx = new StellarSdk.TransactionBuilder(account, { fee: "100", networkPassphrase: DEFAULT_NETWORK })
    .addOperation(StellarSdk.Operation.invokeContractFunction({ contract: contractId, function: fn, args }))
    .setTimeout(30)
    .build();
  const res = await server.simulateTransaction(tx);
  if (rpcNamespace.Api?.isSimulationError?.(res) || res.error) {
    throw new Error(res.error || "simulation failed");
  }
  return res.result?.retval ? StellarSdk.scValToNative(res.result.retval) : null;
}

export async function readContractState({ rpcUrl, contractId }) {
  if (!contractId) return {};
  const server = serverFor(rpcUrl);
  const [root, commitment] = await Promise.all([
    simulateGetter(server, contractId, "current_state_root").then(bytesToHex).catch(() => ""),
    simulateGetter(server, contractId, "policy_commitment").then(bytesToHex).catch(() => ""),
  ]);
  return { root, commitment };
}

// Read a token (SAC) balance for an address. Returns raw smallest-unit BigInt as string.
export async function readTokenBalance({ rpcUrl, tokenId, address }) {
  if (!tokenId || !address) return null;
  const server = serverFor(rpcUrl);
  const arg = new StellarSdk.Address(address).toScVal();
  const v = await simulateGetter(server, tokenId, "balance", [arg]);
  return v == null ? "0" : v.toString();
}

// Read token metadata: { decimals, symbol, name }.
export async function readTokenMeta({ rpcUrl, tokenId }) {
  if (!tokenId) return {};
  const server = serverFor(rpcUrl);
  const [decimals, symbol, name] = await Promise.all([
    simulateGetter(server, tokenId, "decimals").catch(() => null),
    simulateGetter(server, tokenId, "symbol").catch(() => null),
    simulateGetter(server, tokenId, "name").catch(() => null),
  ]);
  return { decimals, symbol, name };
}

// Generic helper: simulate -> prepare -> ask the wallet to sign the XDR -> submit -> confirm.
// `signXdr(xdr, networkPassphrase)` is the wallet signing callback. No secret key here.
async function signAndSubmit({ server, tx, networkPassphrase, signXdr }) {
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
  const signedXdr = await signXdr(prepared.toXDR(), networkPassphrase);
  const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const sent = await server.sendTransaction(signedTx);
  if (sent.status === "ERROR") throw new Error(JSON.stringify(sent.errorResult || sent));
  const result = await waitForTx(server, sent.hash);
  return { hash: sent.hash, result, footprint };
}

// Fund the warrant contract from the connected wallet (the wallet is `from`).
export async function fundContract({ rpcUrl, networkPassphrase, sourcePublicKey, signXdr, contractId, amount }) {
  const server = serverFor(rpcUrl);
  const account = await server.getAccount(sourcePublicKey);
  const op = StellarSdk.Operation.invokeContractFunction({
    contract: contractId,
    function: "fund",
    args: [
      new StellarSdk.Address(sourcePublicKey).toScVal(),
      StellarSdk.nativeToScVal(BigInt(amount), { type: "i128" }),
    ],
  });
  const tx = new StellarSdk.TransactionBuilder(account, { fee: "1000000", networkPassphrase })
    .addOperation(op).setTimeout(120).build();
  const { hash, result } = await signAndSubmit({ server, tx, networkPassphrase, signXdr });
  if (result.status !== "SUCCESS") {
    const r = errorReason(result);
    throw new Error(`funding did not confirm (${result.status}${r.name ? `, ${r.name}` : ""})`);
  }
  return { hash, status: "SUCCESS" };
}

// Compliant path: simulate (the pre-flight gate), wallet-sign, submit, confirm SUCCESS,
// and return the BORROWED footprint so adversarial calls can force-submit failing txs.
export async function settleWithPrice({ rpcUrl, networkPassphrase, sourcePublicKey, signXdr, contractId, proofHex, publicHex, price, timestamp, signatureHex }) {
  const server = serverFor(rpcUrl);
  const account = await server.getAccount(sourcePublicKey);
  const tx = new StellarSdk.TransactionBuilder(account, { fee: "1000000", networkPassphrase })
    .addOperation(settleOp(contractId, settleArgs({ proofHex, publicHex, price, timestamp, signatureHex })))
    .setTimeout(120).build();
  const { hash, result, footprint } = await signAndSubmit({ server, tx, networkPassphrase, signXdr });
  if (result.status !== "SUCCESS") {
    const r = errorReason(result);
    throw new Error(`settlement did not confirm (${result.status}${r.name ? `, ${r.name}` : ""})`);
  }
  return { hash, status: "SUCCESS", footprint };
}

// Adversarial path: build a settle tx with a BORROWED footprint from a prior valid
// simulation and submit it WITHOUT a pre-flight gate, so a deliberately invalid
// settlement still lands on-chain and the contract reverts. The wallet still signs it.
export async function settleWithFootprint({ rpcUrl, networkPassphrase, sourcePublicKey, signXdr, contractId, proofHex, publicHex, price, timestamp, signatureHex, footprint }) {
  if (!footprint?.sorobanData) throw new Error("no borrowed footprint — run a compliant settlement first");
  const server = serverFor(rpcUrl);
  const fee = (BigInt(footprint.minResourceFee) + 5_000_000n).toString();
  const args = settleArgs({ proofHex, publicHex, price, timestamp, signatureHex });

  let lastHash;
  for (let round = 0; round < 4; round++) {
    const account = await server.getAccount(sourcePublicKey);
    const tx = new StellarSdk.TransactionBuilder(account, { fee, networkPassphrase })
      .addOperation(settleOp(contractId, args))
      .setSorobanData(footprint.sorobanData)
      .setTimeout(120)
      .build();
    const signedXdr = await signXdr(tx.toXDR(), networkPassphrase);
    const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, networkPassphrase);

    const sent = await server.sendTransaction(signedTx);
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
