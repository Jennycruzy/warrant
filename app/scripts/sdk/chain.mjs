import * as S from "@stellar/stellar-sdk";

export const NET = "Test SDF Network ; September 2015";
export const RPC = "https://soroban-testnet.stellar.org";
export const server = new S.rpc.Server(RPC);
export const explorerTx = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`;
export const explorerC = (c) => `https://stellar.expert/explorer/testnet/contract/${c}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function accountExists(pub) {
  try { await server.getAccount(pub); return true; } catch { return false; }
}

// getAccount that rides out RPC read-replica lag ("Account not found" right after funding).
export async function getAccountRetry(pub, tries = 12) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await server.getAccount(pub); }
    catch (e) { last = e; if (/not found/i.test(e.message)) { await sleep(1500); continue; } throw e; }
  }
  throw last;
}

export async function waitForAccount(pub, tries = 15) {
  for (let i = 0; i < tries; i++) {
    if (await accountExists(pub)) return true;
    await sleep(1500);
  }
  return false;
}

// Friendbot-fund, retrying the call itself until the account is really visible.
export async function fundFriendbot(pub) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await accountExists(pub)) return true;
    try {
      await fetch(`https://friendbot.stellar.org/?addr=${pub}`);
    } catch { /* network blip; re-check below */ }
    if (await waitForAccount(pub, 8)) return true;
    await sleep(2000);
  }
  throw new Error(`friendbot could not fund ${pub}`);
}

// Horizon is authoritative for inclusion; returns {found, successful} or {found:false} if dropped.
export async function confirmHorizon(hash, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`https://horizon-testnet.stellar.org/transactions/${hash}`);
      if (r.status === 200) { const j = await r.json(); return { found: true, successful: j.successful }; }
    } catch { /* retry */ }
    await sleep(2000);
  }
  return { found: false };
}

// RPC return value (for createContract address etc.), riding out lag.
async function rpcReturnValue(hash) {
  for (let i = 0; i < 10; i++) {
    const t = await server.getTransaction(hash);
    if (t.status === "SUCCESS") return t.returnValue;
    await sleep(1500);
  }
  return null;
}

const errName = (sent) => {
  try { return sent.errorResult?.result?.().switch?.().name; } catch { return undefined; }
};
const RETRYABLE = new Set(["txBadSeq", "txNoAccount", "txTooLate", "TRY_AGAIN_LATER"]);

// Send a freshly-built tx, retrying transient errors (RPC sequence / replication lag).
async function sendRetry(buildFn, signer, label) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const account = await getAccountRetry(signer.publicKey());
    const prepared = buildFn(account);
    prepared.sign(signer);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "TRY_AGAIN_LATER") { lastErr = "TRY_AGAIN_LATER"; await sleep(3000); continue; }
    if (sent.status === "ERROR") {
      const n = errName(sent);
      if (RETRYABLE.has(n)) { lastErr = n; await sleep(2500); continue; }
      throw new Error(`[${label}] send ERROR: ${JSON.stringify(sent.errorResult)}`);
    }
    return sent;
  }
  throw new Error(`[${label}] gave up after retries (${lastErr})`);
}

// Transient infra failures from read-replica state lag (entry exists / resources
// under-estimated against a node that hasn't caught up). NOT genuine contract errors.
const TRANSIENT = /MissingValue|Storage|not found|Account not found|ExceededLimit|exceeds amount/i;
const isContractError = (s) => /Error\(Contract/i.test(s || "");

// Read the on-chain failure reason (error diagnostic) for a confirmed-FAILED tx.
async function txFailReason(hash) {
  for (let i = 0; i < 6; i++) {
    const t = await server.getTransaction(hash);
    if (t.status === "FAILED") {
      for (const d of t.diagnosticEventsXdr || []) {
        try {
          const ev = S.xdr.DiagnosticEvent.fromXDR(d, "base64").event().body().v0();
          const topics = ev.topics().map((x) => { try { return S.scValToNative(x); } catch { return x.switch().name; } });
          if (String(topics[0]) === "error") {
            let data; try { data = S.scValToNative(ev.data()); } catch { data = ev.data().switch().name; }
            return JSON.stringify({ topics, data }, (k, v) => typeof v === "bigint" ? v.toString() : v);
          }
        } catch { /* skip */ }
      }
      return "FAILED (no error diagnostic)";
    }
    await sleep(1200);
  }
  return "FAILED (unresolved)";
}

// Simulate + assemble + sign + send a Soroban op that should succeed. Re-simulates
// fresh each round so a stale/under-resourced simulation self-heals on retry.
export async function submitAuto(op, signer, label = "op") {
  let lastReason;
  for (let round = 0; round < 8; round++) {
    const probe = await getAccountRetry(signer.publicKey());
    const baseTx = new S.TransactionBuilder(probe, { fee: "1000000", networkPassphrase: NET })
      .addOperation(op).setTimeout(120).build();
    const sim = await server.simulateTransaction(baseTx);
    if (S.rpc.Api.isSimulationError(sim)) {
      lastReason = sim.error.split("\n")[0];
      if (TRANSIENT.test(sim.error) && !isContractError(sim.error)) { await sleep(2500); continue; }
      throw new Error(`[${label}] simulation error: ${lastReason}`);
    }
    const sent = await sendRetry((account) => {
      const tx = new S.TransactionBuilder(account, { fee: "1000000", networkPassphrase: NET })
        .addOperation(op).setTimeout(120).build();
      return S.rpc.assembleTransaction(tx, sim).build();
    }, signer, label);
    const c = await confirmHorizon(sent.hash);
    if (!c.found) { lastReason = "dropped"; continue; }            // resubmit
    if (c.successful) return { hash: sent.hash, sim, returnValue: await rpcReturnValue(sent.hash) };
    lastReason = await txFailReason(sent.hash);
    if (TRANSIENT.test(lastReason) && !isContractError(lastReason)) { await sleep(2500); continue; }
    throw new Error(`[${label}] reverted on-chain: ${lastReason}`);
  }
  throw new Error(`[${label}] gave up after retries (${lastReason})`);
}

// Build a tx with a BORROWED Soroban footprint (from a prior valid sim) and submit
// WITHOUT a pre-flight gate, so a deliberately invalid invocation still lands on-chain
// and the contract reverts. Returns { hash, status } and tolerates FAILED.
export async function submitWithFootprint(op, signer, sorobanDataXdr, minResourceFee, label = "adversarial") {
  const fee = (BigInt(minResourceFee) + 5_000_000n).toString();
  const buildFn = (account) =>
    new S.TransactionBuilder(account, { fee, networkPassphrase: NET })
      .addOperation(op).setSorobanData(sorobanDataXdr).setTimeout(120).build();
  for (let round = 0; round < 4; round++) {
    const sent = await sendRetry(buildFn, signer, label);
    const c = await confirmHorizon(sent.hash);
    if (c.found) return { hash: sent.hash, status: c.successful ? "SUCCESS" : "FAILED" };
    // dropped: resubmit
  }
  throw new Error(`[${label}] transaction dropped repeatedly`);
}

export async function simulateOp(op, sourcePub) {
  const account = new S.Account(sourcePub, "0");
  const tx = new S.TransactionBuilder(account, { fee: "1000000", networkPassphrase: NET })
    .addOperation(op).setTimeout(120).build();
  return server.simulateTransaction(tx);
}

// Classic (non-Soroban) op: build, sign, send, confirm.
export async function submitClassic(op, signer, label = "classic") {
  const buildFn = (account) =>
    new S.TransactionBuilder(account, { fee: "10000", networkPassphrase: NET })
      .addOperation(op).setTimeout(120).build();
  for (let round = 0; round < 4; round++) {
    const sent = await sendRetry(buildFn, signer, label);
    const c = await confirmHorizon(sent.hash);
    if (c.found) {
      if (!c.successful) throw new Error(`[${label}] tx ${sent.hash} failed on-chain`);
      return { hash: sent.hash };
    }
  }
  throw new Error(`[${label}] transaction dropped repeatedly`);
}

// ScVal helpers
export const scBytes = (hex) => S.xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
export const scBytesN = (hex) => S.nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
export const scU64 = (v) => S.nativeToScVal(BigInt(v), { type: "u64" });
export const scU32 = (v) => S.nativeToScVal(Number(v), { type: "u32" });
export const scI128 = (v) => S.nativeToScVal(BigInt(v), { type: "i128" });
export const scAddr = (g) => new S.Address(g).toScVal();

export function invoke(contractId, fn, args) {
  return S.Operation.invokeContractFunction({ contract: contractId, function: fn, args });
}

// read-only sim of a contract getter -> native value
export async function read(contractId, fn, args = []) {
  const sim = await simulateOp(invoke(contractId, fn, args), S.Keypair.random().publicKey());
  if (S.rpc.Api.isSimulationError(sim)) return { error: sim.error.split("\n")[0] };
  return { value: sim.result?.retval ? S.scValToNative(sim.result.retval) : null };
}

export { S };
