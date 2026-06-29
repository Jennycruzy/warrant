import * as snarkjs from "snarkjs";
import fs from "fs";
import {
  S, NET, fundFriendbot, submitAuto, submitClassic, invoke, read,
  scBytes, scBytesN, scU32, scAddr, scI128,
} from "./chain.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// After init, the RPC simulation node may lag behind Horizon: a follow-up call can
// still see NotInitialized (#2). Poll a getter until the new state is visible.
async function waitInitialized(warrantId, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await read(warrantId, "current_state_root");
    if (!r.error && r.value) return;
    await sleep(2000);
  }
}
import { vkToHex, proofToHex, publicToHex } from "./encode.mjs";

export const WASM_HASH = "1d9d75d90eed9c97515ce17531f76b1adbb21111064a91a6fe4084bdf7594e45";
// Live Reflector SEP-40 oracle (CEX/DEX feed) on Stellar testnet, base USD, 14 decimals.
export const REFLECTOR = {
  contract: "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63",
  asset: "XLM",
};
export const ORACLE = {
  oraclePubKey: "eaee897380a52a6b18205c33d79ed68e26f23ab85f46a9f74e044a989411af0b",
  signatureHex: "9ad495a06680cc8b1fc16981dfeba9a1d4acc87f972ce5b135589c7feeb03aaf31d60c600f85a82e754e1780be689968b07c7cbaac43d035cb3beb2000821200",
  messageHex: "000000000000000a000000006b49d200",
  price: "10", timestamp: "1800000000",
};
// Proving artifacts ship in the frontend public dir (resolved relative to this file).
const pub = (p) => new URL(`../../frontend/public/${p}`, import.meta.url).pathname;
const ART = {
  wasm: pub("circuits/mandate_oracle_allow.wasm"),
  zkey: pub("proving/mandate_oracle_allow_final.zkey"),
  validInput: pub("valid.input.json"),
};

export async function proveValid() {
  const input = JSON.parse(fs.readFileSync(ART.validInput));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, ART.wasm, ART.zkey);
  return { proofHex: proofToHex(proof), publicHex: publicToHex(publicSignals), publicSignals };
}

// Prove the i-th settlement in the precomputed chained sequence (1-based). Each
// extends the previous one's state root, so submitting them in order performs
// many real compliant settlements against the SAME contract.
export async function proveSeq(i) {
  const file = pub(`seq/settle_${String(i).padStart(2, "0")}.input.json`);
  const input = JSON.parse(fs.readFileSync(file));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, ART.wasm, ART.zkey);
  return { proofHex: proofToHex(proof), publicHex: publicToHex(publicSignals), publicSignals };
}

export async function getVkHex() {
  const vk = await snarkjs.zKey.exportVerificationKey(ART.zkey);
  return vkToHex(vk);
}

export function makeKeys() {
  return { admin: S.Keypair.random(), recipient: S.Keypair.random() };
}

export async function fundKeys(keys) {
  await fundFriendbot(keys.admin.publicKey());
  await fundFriendbot(keys.recipient.publicKey());
}

// Deploy the USDW test stablecoin as a Stellar Asset Contract, admin = issuer.
export async function deployStablecoin(admin) {
  const asset = new S.Asset("USDW", admin.publicKey());
  const tokenId = asset.contractId(NET);
  // deploy SAC instance (idempotent: ignore "already exists")
  try {
    const op = S.Operation.createStellarAssetContract({ asset });
    await submitAuto(op, admin, "deploy USDW SAC");
  } catch (e) {
    if (!/exist/i.test(e.message)) throw e;
  }
  return { asset, tokenId };
}

export async function trustline(account, asset) {
  await submitClassic(S.Operation.changeTrust({ asset }), account, "changeTrust USDW");
}

// Mint USDW into an address (contract or account) via the SAC mint (issuer auth).
export async function mint(tokenId, admin, toAddr, amount) {
  const op = invoke(tokenId, "mint", [scAddr(toAddr), scI128(amount)]);
  return submitAuto(op, admin, `mint ${amount} USDW`);
}

// Deploy a fresh warrant instance from the on-chain wasm hash.
export async function deployWarrant(admin) {
  const op = S.Operation.createCustomContract({
    address: new S.Address(admin.publicKey()),
    wasmHash: Buffer.from(WASM_HASH, "hex"),
    salt: S.hash(Buffer.from(`warrant-${Date.now()}-${Math.random()}`)),
  });
  const r = await submitAuto(op, admin, "deploy warrant");
  const addr = S.scValToNative(r.returnValue); // contract address string
  return addr;
}

export async function configureWarrant({ admin, recipient, warrantId, tokenId, commitmentHex, genesisRootHex, vkHex, fundAmount }) {
  await submitAuto(invoke(warrantId, "init", [
    scAddr(admin.publicKey()), scAddr(tokenId), scBytesN(commitmentHex), scBytesN(genesisRootHex),
  ]), admin, "init");
  await waitInitialized(warrantId);
  await submitAuto(invoke(warrantId, "set_vk", [scBytes(vkHex)]), admin, "set_vk");
  await submitAuto(invoke(warrantId, "set_oracle", [scBytesN(ORACLE.oraclePubKey)]), admin, "set_oracle");
  await submitAuto(invoke(warrantId, "register_recipient", [scU32(0), scAddr(recipient.publicKey())]), admin, "register_recipient");
  await mint(tokenId, admin, warrantId, fundAmount); // fund the custody contract with USDW
}
