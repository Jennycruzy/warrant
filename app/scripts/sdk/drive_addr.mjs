// WARRANT address-bound recipient driver (real testnet).
//
// Provisions a fresh address-bound custody contract, proves a valid account
// payment and a valid contract payment, and submits real reverted transactions
// for recipient-byte and recipient-type mismatch attempts.
import * as snarkjs from "snarkjs";
import fs from "fs";
import {
  S, NET, server, fundFriendbot, submitAuto, submitWithFootprint, submitClassic,
  invoke, read, scBytes, scBytesN, scU64, scAddr, scI128, explorerTx, explorerC,
  getAccountRetry,
} from "./chain.mjs";
import { proofToHex, publicToHex, vkToHex } from "./encode.mjs";
import { addressIdentity } from "../address_identity.mjs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { poseidon3, poseidon4 } = require("../poseidon.js");
const { buildTree, proofForIndex, addressLeaf } = require("../allowlist.js");

const ORACLE = {
  oraclePubKey: "eaee897380a52a6b18205c33d79ed68e26f23ab85f46a9f74e044a989411af0b",
  signatureHex: "9ad495a06680cc8b1fc16981dfeba9a1d4acc87f972ce5b135589c7feeb03aaf31d60c600f85a82e754e1780be689968b07c7cbaac43d035cb3beb2000821200",
  price: "10",
  timestamp: "1800000000",
};
const MANDATE = { maxPerTx: "100", maxPosition: "1000", drawdownLimit: "100" };
const DEPTH = 3;
const FUND = "100000";
const AMOUNT = "10";
const ART = {
  wasm: "app/build/mandate_oracle_allow_addr_js/mandate_oracle_allow_addr.wasm",
  zkey: "app/build/mandate_oracle_allow_addr_final.zkey",
  contractWasm: "app/target/wasm32v1-none/release/warrant_addr.optimized.wasm",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (u8) => (u8 == null ? null : Buffer.from(u8).toString("hex"));
const dec2hex32 = (d) => BigInt(d).toString(16).padStart(64, "0");

async function failReason(hash) {
  for (let i = 0; i < 8; i++) {
    const t = await server.getTransaction(hash);
    if (t.status === "FAILED") {
      for (const d of t.diagnosticEventsXdr || []) {
        let ev;
        try { ev = typeof d === "string" ? S.xdr.DiagnosticEvent.fromXDR(d, "base64") : d; } catch { continue; }
        try {
          const v0 = ev.event().body().v0();
          const topics = v0.topics().map((x) => { try { return S.scValToNative(x); } catch { return x.switch().name; } });
          if (String(topics[0]) === "error") {
            let data; try { data = S.scValToNative(v0.data()); } catch { data = v0.data().switch?.().name; }
            return JSON.stringify({ topics, data }, (k, v) => (typeof v === "bigint" ? v.toString() : v));
          }
        } catch { /* skip */ }
      }
      return "FAILED (no error diagnostic)";
    }
    await sleep(1200);
  }
  return "FAILED (unresolved)";
}

async function simulateFootprint(op, signer) {
  const account = await getAccountRetry(signer.publicKey());
  const tx = new S.TransactionBuilder(account, { fee: "1000000", networkPassphrase: NET })
    .addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) {
    throw new Error(`footprint simulation error: ${sim.error.split("\n")[0]}`);
  }
  return {
    sorobanB64: sim.transactionData.build().toXDR("base64"),
    minResourceFee: sim.minResourceFee,
  };
}

async function waitInitialized(contractId, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await read(contractId, "current_state_root");
    if (!r.error && r.value) return;
    await sleep(2000);
  }
}

async function readState(contractId, tokenId, accountRecipient, contractRecipient) {
  const root = hx((await read(contractId, "current_state_root")).value);
  const custody = (await read(tokenId, "balance", [scAddr(contractId)])).value?.toString();
  const accountBal = (await read(tokenId, "balance", [scAddr(accountRecipient)])).value?.toString();
  const contractBal = (await read(tokenId, "balance", [scAddr(contractRecipient)])).value?.toString();
  return { root, custody, accountBal, contractBal };
}

async function waitForState(contractId, tokenId, accountRecipient, contractRecipient, pred, tries = 20) {
  let state;
  for (let i = 0; i < tries; i++) {
    state = await readState(contractId, tokenId, accountRecipient, contractRecipient);
    if (pred(state)) return state;
    await sleep(2000);
  }
  return state;
}

async function deployStablecoin(admin) {
  const asset = new S.Asset("USDW", admin.publicKey());
  const tokenId = asset.contractId(NET);
  try {
    await submitAuto(S.Operation.createStellarAssetContract({ asset }), admin, "deploy USDW SAC");
  } catch (e) {
    if (!/exist/i.test(e.message)) throw e;
  }
  return { asset, tokenId };
}

async function trustline(account, asset) {
  await submitClassic(S.Operation.changeTrust({ asset }), account, "changeTrust USDW");
}

async function mint(tokenId, admin, toAddr, amount) {
  return submitAuto(invoke(tokenId, "mint", [scAddr(toAddr), scI128(amount)]), admin, `mint ${amount} USDW`);
}

async function uploadWasm(admin) {
  const wasm = fs.readFileSync(ART.contractWasm);
  const hashHex = S.hash(wasm).toString("hex");
  const upload = await submitAuto(S.Operation.uploadContractWasm({ wasm }), admin, "upload warrant_addr wasm");
  return { hashHex, uploadHash: upload.hash };
}

async function deployCustom(admin, wasmHashHex, label) {
  const op = S.Operation.createCustomContract({
    address: new S.Address(admin.publicKey()),
    wasmHash: Buffer.from(wasmHashHex, "hex"),
    salt: S.hash(Buffer.from(`${label}-${Date.now()}-${Math.random()}`)),
  });
  const r = await submitAuto(op, admin, `deploy ${label}`);
  return { contractId: S.scValToNative(r.returnValue), txHash: r.hash };
}

async function vkHex() {
  return vkToHex(await snarkjs.zKey.exportVerificationKey(ART.zkey));
}

async function buildInput({ recipients, recipient, position, peakEquity, amount, price }) {
  const identities = recipients.map((address) => addressIdentity(address));
  const leaves = [];
  for (const identity of identities) {
    leaves.push(await addressLeaf(identity));
  }
  const tree = await buildTree(leaves, DEPTH);
  const recipientIdentity = addressIdentity(recipient);
  const recipientLeaf = await addressLeaf(recipientIdentity);
  const idx = leaves.map(String).indexOf(String(recipientLeaf));
  if (idx < 0) throw new Error(`recipient is not in address allowlist: ${recipient}`);
  const { pathElements, pathIndices } = proofForIndex(tree, idx);

  const currentEquity = (BigInt(position) * BigInt(price)).toString();
  const nextPosition = (BigInt(position) + BigInt(amount)).toString();
  const nextEquity = (BigInt(nextPosition) * BigInt(price)).toString();
  const nextPeak = (BigInt(nextEquity) >= BigInt(peakEquity) ? BigInt(nextEquity) : BigInt(peakEquity)).toString();
  const policyCommitment = await poseidon4(MANDATE.maxPerTx, MANDATE.maxPosition, MANDATE.drawdownLimit, tree.root);
  const prevStateRoot = await poseidon3(position, peakEquity, currentEquity);
  const nextStateRoot = await poseidon3(nextPosition, nextPeak, nextEquity);

  return {
    input: {
      policyCommitment,
      prevStateRoot,
      nextStateRoot,
      amount: String(amount),
      recipientType: recipientIdentity.recipientType,
      recipientHi: recipientIdentity.recipientHi,
      recipientLo: recipientIdentity.recipientLo,
      price: String(price),
      ...MANDATE,
      allowlistRoot: tree.root,
      prevPosition: String(position),
      peakEquity: String(peakEquity),
      pathElements,
      pathIndices,
    },
    meta: {
      commitmentHex: dec2hex32(policyCommitment),
      prevRootHex: dec2hex32(prevStateRoot),
      nextRootHex: dec2hex32(nextStateRoot),
      nextPosition,
      nextPeak,
    },
  };
}

async function prove(input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, ART.wasm, ART.zkey);
  return { proofHex: proofToHex(proof), publicHex: publicToHex(publicSignals), publicSignals };
}

async function expectNoProof(label, buildParams) {
  try {
    const candidate = await buildInput(buildParams);
    await prove(candidate.input);
    console.log(`  ${label}: UNEXPECTED proof produced`);
    return false;
  } catch (e) {
    console.log(`  ${label}: proof rejected as expected (${String(e.message).split("\n")[0]})`);
    return true;
  }
}

console.log("== WARRANT address-bound recipient demo (real testnet) ==\n");
const admin = S.Keypair.random();
const accountRecipient = S.Keypair.random();
const redirectRecipient = S.Keypair.random();
console.log("admin             :", admin.publicKey());
console.log("account recipient :", accountRecipient.publicKey());
console.log("redirect recipient:", redirectRecipient.publicKey());
console.log("funding accounts via friendbot...");
await fundFriendbot(admin.publicKey());
await fundFriendbot(accountRecipient.publicKey());
await fundFriendbot(redirectRecipient.publicKey());

console.log("deploying USDW stablecoin SAC...");
const { asset, tokenId } = await deployStablecoin(admin);
await trustline(accountRecipient, asset);

console.log("uploading additive warrant_addr wasm...");
const uploaded = await uploadWasm(admin);
console.log("  upload tx:", explorerTx(uploaded.uploadHash));
console.log("  wasm hash:", uploaded.hashHex);

console.log("deploying custody contract and separate contract recipient...");
const custody = await deployCustom(admin, uploaded.hashHex, "warrant-addr-custody");
const contractRecipient = await deployCustom(admin, uploaded.hashHex, "warrant-addr-recipient");
const contractRecipientId = contractRecipient.contractId;
console.log("  custody contract :", explorerC(custody.contractId), "tx", explorerTx(custody.txHash));
console.log("  contract recipient:", explorerC(contractRecipientId), "tx", explorerTx(contractRecipient.txHash));

const recipients = [accountRecipient.publicKey(), contractRecipientId];
const first = await buildInput({
  recipients,
  recipient: accountRecipient.publicKey(),
  position: "100",
  peakEquity: "1000",
  amount: AMOUNT,
  price: ORACLE.price,
});

console.log("configuring custody contract (init, set_vk, set_oracle, fund)...");
await submitAuto(invoke(custody.contractId, "init", [
  scAddr(admin.publicKey()),
  scAddr(tokenId),
  scBytesN(first.meta.commitmentHex),
  scBytesN(first.meta.prevRootHex),
]), admin, "init");
await waitInitialized(custody.contractId);
await submitAuto(invoke(custody.contractId, "set_vk", [scBytes(await vkHex())]), admin, "set_vk");
await submitAuto(invoke(custody.contractId, "set_oracle", [scBytesN(ORACLE.oraclePubKey)]), admin, "set_oracle");
await mint(tokenId, admin, custody.contractId, FUND);

const start = await waitForState(custody.contractId, tokenId, accountRecipient.publicKey(), contractRecipientId, (s) => s.custody === FUND);
console.log("\n== start state ==");
console.log(`root=${start.root} custody=${start.custody} account=${start.accountBal} contract=${start.contractBal}`);

const firstProof = await prove(first.input);
console.log("\nPhase E local no-proof regressions");
const wrongTypeContract = S.StrKey.encodeContract(new S.Address(accountRecipient.publicKey()).toBuffer());
await expectNoProof("over maxPerTx", {
  recipients,
  recipient: accountRecipient.publicKey(),
  position: "100",
  peakEquity: "1000",
  amount: "101",
  price: ORACLE.price,
});
await expectNoProof("over maxPosition", {
  recipients,
  recipient: accountRecipient.publicKey(),
  position: "950",
  peakEquity: "9500",
  amount: "100",
  price: ORACLE.price,
});
await expectNoProof("drawdown breach at lower price", {
  recipients,
  recipient: accountRecipient.publicKey(),
  position: "100",
  peakEquity: "1000",
  amount: AMOUNT,
  price: "8",
});
await expectNoProof("wrong type for allowlisted bytes", {
  recipients,
  recipient: wrongTypeContract,
  position: "100",
  peakEquity: "1000",
  amount: AMOUNT,
  price: ORACLE.price,
});

console.log("\nPhase D pre-checks with a valid account proof (must REVERT on-chain)");
const validAccountOp = (recipient) => invoke(custody.contractId, "settle_with_price", [
  scBytes(firstProof.proofHex),
  scBytes(firstProof.publicHex),
  scAddr(recipient),
  scU64(ORACLE.price),
  scU64(ORACLE.timestamp),
  scBytesN(ORACLE.signatureHex),
]);
const fp = await simulateFootprint(validAccountOp(accountRecipient.publicKey()), admin);

const redirect = await submitWithFootprint(
  validAccountOp(redirectRecipient.publicKey()),
  admin,
  fp.sorobanB64,
  fp.minResourceFee,
  "redirect recipient bytes",
);
console.log(`  REDIRECT ${redirect.status === "FAILED" ? "REVERTED" : redirect.status}: ${explorerTx(redirect.hash)}`);
console.log("    reason:", redirect.status === "FAILED" ? await failReason(redirect.hash) : "(landed unexpectedly)");

const typeConfusion = await submitWithFootprint(
  validAccountOp(contractRecipientId),
  admin,
  fp.sorobanB64,
  fp.minResourceFee,
  "recipient type confusion",
);
console.log(`  TYPE-CONFUSION ${typeConfusion.status === "FAILED" ? "REVERTED" : typeConfusion.status}: ${explorerTx(typeConfusion.hash)}`);
console.log("    reason:", typeConfusion.status === "FAILED" ? await failReason(typeConfusion.hash) : "(landed unexpectedly)");

console.log("\nGate C.1 — compliant account recipient payment");
const accountOk = await submitAuto(validAccountOp(accountRecipient.publicKey()), admin, "settle account recipient");
const afterAccount = await waitForState(
  custody.contractId,
  tokenId,
  accountRecipient.publicKey(),
  contractRecipientId,
  (s) => s.root === first.meta.nextRootHex && BigInt(s.accountBal) === BigInt(start.accountBal) + BigInt(AMOUNT),
);
console.log(`  SUCCESS ${explorerTx(accountOk.hash)}`);
console.log(`  root ${start.root.slice(0, 12)}... -> ${afterAccount.root.slice(0, 12)}...`);
console.log(`  balances custody ${start.custody}->${afterAccount.custody} account ${start.accountBal}->${afterAccount.accountBal}`);

console.log("\nGate C.2 — compliant contract recipient payment");
const second = await buildInput({
  recipients,
  recipient: contractRecipientId,
  position: first.meta.nextPosition,
  peakEquity: first.meta.nextPeak,
  amount: AMOUNT,
  price: ORACLE.price,
});
const secondProof = await prove(second.input);
const contractOk = await submitAuto(invoke(custody.contractId, "settle_with_price", [
  scBytes(secondProof.proofHex),
  scBytes(secondProof.publicHex),
  scAddr(contractRecipientId),
  scU64(ORACLE.price),
  scU64(ORACLE.timestamp),
  scBytesN(ORACLE.signatureHex),
]), admin, "settle contract recipient");
const afterContract = await waitForState(
  custody.contractId,
  tokenId,
  accountRecipient.publicKey(),
  contractRecipientId,
  (s) => s.root === second.meta.nextRootHex && BigInt(s.contractBal) === BigInt(afterAccount.contractBal) + BigInt(AMOUNT),
);
console.log(`  SUCCESS ${explorerTx(contractOk.hash)}`);
console.log(`  root ${afterAccount.root.slice(0, 12)}... -> ${afterContract.root.slice(0, 12)}...`);
console.log(`  balances custody ${afterAccount.custody}->${afterContract.custody} contract ${afterAccount.contractBal}->${afterContract.contractBal}`);

console.log("\nPhase E on-chain forged/replay regressions (must REVERT)");
const contractFp = {
  sorobanB64: contractOk.sim.transactionData.build().toXDR("base64"),
  minResourceFee: contractOk.sim.minResourceFee,
};
const forgedSignals = [...secondProof.publicSignals];
forgedSignals[1] = secondProof.publicSignals[2];
forgedSignals[2] = "12345";
const forged = await submitWithFootprint(invoke(custody.contractId, "settle_with_price", [
  scBytes(secondProof.proofHex),
  scBytes(publicToHex(forgedSignals)),
  scAddr(contractRecipientId),
  scU64(ORACLE.price),
  scU64(ORACLE.timestamp),
  scBytesN(ORACLE.signatureHex),
]), admin, contractFp.sorobanB64, contractFp.minResourceFee, "forged address-bound proof");
console.log(`  FORGED ${forged.status === "FAILED" ? "REVERTED" : forged.status}: ${explorerTx(forged.hash)}`);
console.log("    reason:", forged.status === "FAILED" ? await failReason(forged.hash) : "(landed unexpectedly)");

const replay = await submitWithFootprint(invoke(custody.contractId, "settle_with_price", [
  scBytes(secondProof.proofHex),
  scBytes(secondProof.publicHex),
  scAddr(contractRecipientId),
  scU64(ORACLE.price),
  scU64(ORACLE.timestamp),
  scBytesN(ORACLE.signatureHex),
]), admin, contractFp.sorobanB64, contractFp.minResourceFee, "replayed address-bound proof");
console.log(`  REPLAY ${replay.status === "FAILED" ? "REVERTED" : replay.status}: ${explorerTx(replay.hash)}`);
console.log("    reason:", replay.status === "FAILED" ? await failReason(replay.hash) : "(landed unexpectedly)");

console.log("\n== SUMMARY ==");
console.log("custody contract      :", explorerC(custody.contractId));
console.log("contract recipient    :", explorerC(contractRecipientId));
console.log("wasm upload           :", explorerTx(uploaded.uploadHash));
console.log("redirect revert       :", explorerTx(redirect.hash), "(expected RecipientMismatch #18)");
console.log("type-confusion revert :", explorerTx(typeConfusion.hash), "(expected RecipientTypeMismatch #19)");
console.log("account success       :", explorerTx(accountOk.hash));
console.log("contract success      :", explorerTx(contractOk.hash));
console.log("forged revert         :", explorerTx(forged.hash), "(expected ProofInvalid #10)");
console.log("replay revert         :", explorerTx(replay.hash), "(expected StaleStateRoot #9)");
console.log("exported functions    : init, set_vk, set_oracle, fund, settle, settle_with_price, settle_with_reflector, current_state_root, policy_commitment, get_token");
process.exit(0);
