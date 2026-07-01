// Provision a fresh address-bound WARRANT demo contract and write frontend
// public artifacts for the reversible UI switch.
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import {
  S, NET, fundFriendbot, submitAuto, submitClassic, invoke, read,
  scBytes, scBytesN, scAddr, scI128, explorerTx, explorerC,
} from "./chain.mjs";
import { vkToHex } from "./encode.mjs";
import { addressIdentity } from "../address_identity.mjs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { poseidon3, poseidon4 } = require("../poseidon.js");
const { buildTree, proofForIndex, addressLeaf } = require("../allowlist.js");

const ROOT = new URL("../../..", import.meta.url).pathname;
const pub = (...p) => path.join(ROOT, "app/frontend/public", ...p);
const ART = {
  wasm: path.join(ROOT, "app/build/mandate_oracle_allow_addr_js/mandate_oracle_allow_addr.wasm"),
  zkey: path.join(ROOT, "app/build/mandate_oracle_allow_addr_final.zkey"),
  contractWasm: path.join(ROOT, "app/target/wasm32v1-none/release/warrant_addr.optimized.wasm"),
};
const ORACLE = {
  oraclePubKey: "eaee897380a52a6b18205c33d79ed68e26f23ab85f46a9f74e044a989411af0b",
  signatureHex: "9ad495a06680cc8b1fc16981dfeba9a1d4acc87f972ce5b135589c7feeb03aaf31d60c600f85a82e754e1780be689968b07c7cbaac43d035cb3beb2000821200",
  messageHex: "000000000000000a000000006b49d200",
  price: "10",
  timestamp: "1800000000",
};
const MANDATE = { maxPerTx: "100", maxPosition: "1000", drawdownLimit: "100" };
const DEPTH = 3;
const START = { position: "100", peakEquity: "1000" };
const AMOUNT = "10";
const FUND = "100000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex32 = (d) => BigInt(d).toString(16).padStart(64, "0");

async function waitInitialized(contractId, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await read(contractId, "current_state_root");
    if (!r.error && r.value) return;
    await sleep(2000);
  }
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

async function buildInput({ recipients, recipient, position, peakEquity, amount, price, allowNonMember = false }) {
  const leaves = [];
  for (const entry of recipients) {
    leaves.push(await addressLeaf(addressIdentity(entry.address)));
  }
  const tree = await buildTree(leaves, DEPTH);
  const recipientIdentity = addressIdentity(recipient);
  const recipientLeaf = await addressLeaf(recipientIdentity);
  const idx = leaves.map(String).indexOf(String(recipientLeaf));
  if (idx < 0 && !allowNonMember) throw new Error(`recipient is not in address allowlist: ${recipient}`);
  const { pathElements, pathIndices } = proofForIndex(tree, idx >= 0 ? idx : 0);

  const currentEquity = (BigInt(position) * BigInt(price)).toString();
  const nextPosition = (BigInt(position) + BigInt(amount)).toString();
  const nextEquity = (BigInt(nextPosition) * BigInt(price)).toString();
  const nextPeak = (BigInt(nextEquity) >= BigInt(peakEquity) ? BigInt(nextEquity) : BigInt(peakEquity)).toString();
  const policyCommitment = await poseidon4(MANDATE.maxPerTx, MANDATE.maxPosition, MANDATE.drawdownLimit, tree.root);
  const prevStateRoot = await poseidon3(position, peakEquity, currentEquity);
  const nextStateRoot = await poseidon3(nextPosition, nextPeak, nextEquity);
  const input = {
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
  };
  return {
    input,
    meta: {
      member: idx >= 0,
      commitmentHex: hex32(policyCommitment),
      prevRootHex: hex32(prevStateRoot),
      nextRootHex: hex32(nextStateRoot),
      recipient,
      recipientType: recipientIdentity.recipientType,
      recipientHi: recipientIdentity.recipientHi,
      recipientLo: recipientIdentity.recipientLo,
      recipientLeaf,
      allowlistRoot: tree.root,
      nextPosition,
      nextPeak,
      price: String(price),
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeInput(name, built) {
  writeJson(pub(name), built.input);
  writeJson(pub(`${name}.meta.json`), built.meta);
}

console.log("== address-bound UI demo provisioning ==");
const previousConfig = fs.existsSync(pub("demo-config.json"))
  ? JSON.parse(fs.readFileSync(pub("demo-config.json"), "utf8"))
  : null;

const admin = S.Keypair.random();
const accountRecipient = S.Keypair.random();
const redirectRecipient = S.Keypair.random();
console.log("admin             :", admin.publicKey());
console.log("account recipient :", accountRecipient.publicKey());
console.log("redirect recipient:", redirectRecipient.publicKey());
await fundFriendbot(admin.publicKey());
await fundFriendbot(accountRecipient.publicKey());
await fundFriendbot(redirectRecipient.publicKey());

const { asset, tokenId } = await deployStablecoin(admin);
await trustline(accountRecipient, asset);
const uploaded = await uploadWasm(admin);
const custody = await deployCustom(admin, uploaded.hashHex, "warrant-addr-ui");
const contractRecipient = await deployCustom(admin, uploaded.hashHex, "warrant-addr-ui-recipient");

const recipients = [
  { id: "0", label: "Account recipient", address: accountRecipient.publicKey(), type: 0 },
  { id: "1", label: "Contract recipient", address: contractRecipient.contractId, type: 1 },
];
const seq1 = await buildInput({
  recipients,
  recipient: recipients[0].address,
  position: START.position,
  peakEquity: START.peakEquity,
  amount: AMOUNT,
  price: ORACLE.price,
});
const seq2 = await buildInput({
  recipients,
  recipient: recipients[1].address,
  position: seq1.meta.nextPosition,
  peakEquity: seq1.meta.nextPeak,
  amount: AMOUNT,
  price: ORACLE.price,
});
const overLimit = await buildInput({ recipients, recipient: recipients[0].address, position: START.position, peakEquity: START.peakEquity, amount: "101", price: ORACLE.price });
const breach = await buildInput({ recipients, recipient: recipients[0].address, position: START.position, peakEquity: START.peakEquity, amount: AMOUNT, price: "8" });
const wrongType = S.StrKey.encodeContract(new S.Address(recipients[0].address).toBuffer());
const nonAllow = await buildInput({ recipients, recipient: wrongType, position: START.position, peakEquity: START.peakEquity, amount: AMOUNT, price: ORACLE.price, allowNonMember: true });

await submitAuto(invoke(custody.contractId, "init", [
  scAddr(admin.publicKey()),
  scAddr(tokenId),
  scBytesN(seq1.meta.commitmentHex),
  scBytesN(seq1.meta.prevRootHex),
]), admin, "init");
await waitInitialized(custody.contractId);
await submitAuto(invoke(custody.contractId, "set_vk", [scBytes(await vkHex())]), admin, "set_vk");
await submitAuto(invoke(custody.contractId, "set_oracle", [scBytesN(ORACLE.oraclePubKey)]), admin, "set_oracle");
await mint(tokenId, admin, custody.contractId, FUND);

fs.mkdirSync(pub("circuits"), { recursive: true });
fs.mkdirSync(pub("proving"), { recursive: true });
fs.copyFileSync(ART.wasm, pub("circuits/mandate_oracle_allow_addr.wasm"));
fs.copyFileSync(ART.zkey, pub("proving/mandate_oracle_allow_addr_final.zkey"));
writeInput("valid.input.json", seq1);
writeInput("over_limit.input.json", overLimit);
writeInput("non_allow.input.json", nonAllow);
writeInput("breach.input.json", breach);
writeInput("seq/settle_01.input.json", seq1);
writeInput("seq/settle_02.input.json", seq2);
writeJson(pub("seq/manifest.json"), {
  commitmentHex: seq1.meta.commitmentHex,
  genesisRootHex: seq1.meta.prevRootHex,
  price: ORACLE.price,
  amount: AMOUNT,
  recipientBinding: "address",
  count: 2,
  settlements: [
    { index: 1, file: "seq/settle_01.input.json", amount: AMOUNT, recipientId: "0", recipient: recipients[0].address, prevRootHex: seq1.meta.prevRootHex, nextRootHex: seq1.meta.nextRootHex, prevPosition: START.position, nextPosition: seq1.meta.nextPosition },
    { index: 2, file: "seq/settle_02.input.json", amount: AMOUNT, recipientId: "1", recipient: recipients[1].address, prevRootHex: seq2.meta.prevRootHex, nextRootHex: seq2.meta.nextRootHex, prevPosition: seq1.meta.nextPosition, nextPosition: seq2.meta.nextPosition },
  ],
});
writeJson(pub("demo-config.json"), {
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId: custody.contractId,
  token: tokenId,
  tokenCode: "USDW",
  recipientBinding: "address",
  recipient: recipients[0].address,
  recipients,
  redirectRecipient: redirectRecipient.publicKey(),
  oraclePubKey: ORACLE.oraclePubKey,
  signatureHex: ORACLE.signatureHex,
  messageHex: ORACLE.messageHex,
  commitmentHex: seq1.meta.commitmentHex,
  genesisRootHex: seq1.meta.prevRootHex,
  price: ORACLE.price,
  timestamp: ORACLE.timestamp,
  circuitWasm: "/circuits/mandate_oracle_allow_addr.wasm",
  provingKey: "/proving/mandate_oracle_allow_addr_final.zkey",
  rollback: previousConfig ? {
    contractId: previousConfig.contractId,
    circuitWasm: "/circuits/mandate_oracle_allow.wasm",
    provingKey: "/proving/mandate_oracle_allow_final.zkey",
  } : null,
  mandate: MANDATE,
  book: START,
});

console.log("warrant_addr wasm :", explorerTx(uploaded.uploadHash), uploaded.hashHex);
console.log("custody contract  :", explorerC(custody.contractId));
console.log("contract recipient:", explorerC(contractRecipient.contractId));
console.log("token contract    :", explorerC(tokenId));
console.log("wrote frontend address-bound artifacts");
process.exit(0);
