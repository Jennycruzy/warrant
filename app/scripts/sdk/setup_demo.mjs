import fs from "fs";
import {
  makeKeys, fundKeys, deployStablecoin, trustline, deployWarrant, configureWarrant,
  getVkHex, ORACLE,
} from "./provision.mjs";
import { read, explorerC, scAddr } from "./chain.mjs";

const COMMIT = "2e3da43f5d59ed1757ae427481b609988aca187b7075f43733225a7590893a87";
const GENESIS = "45be8d721eb60367b8485489cb4668c6690bc8571750ade6ba195e97cba264f1";
const FUND = "100000"; // USDW units custodied

const outConfig = process.argv[2] || "demo-config.json";
const outKeys = process.argv[3] || ".keys.json";

console.log("== WARRANT demo provisioning (real testnet) ==\n");

const keys = makeKeys();
console.log("admin    :", keys.admin.publicKey());
console.log("recipient:", keys.recipient.publicKey());
console.log("funding via friendbot...");
await fundKeys(keys);

console.log("deploying USDW stablecoin SAC...");
const { asset, tokenId } = await deployStablecoin(keys.admin);
console.log("  USDW token contract:", tokenId);
console.log("recipient trustline to USDW...");
await trustline(keys.recipient, asset);

console.log("exporting vk + deploying warrant from on-chain wasm hash...");
const vkHex = await getVkHex();
const warrantId = await deployWarrant(keys.admin);
console.log("  warrant contract:", warrantId);

console.log("configuring (init, set_vk, set_oracle, register_recipient, fund)...");
await configureWarrant({
  admin: keys.admin, recipient: keys.recipient, warrantId, tokenId,
  commitmentHex: COMMIT, genesisRootHex: GENESIS, vkHex, fundAmount: FUND,
});

// verify on-chain state
const root = await read(warrantId, "current_state_root");
const commit = await read(warrantId, "policy_commitment");
const bal = await read(tokenId, "balance", [scAddr(warrantId)]);
const rbal = await read(tokenId, "balance", [scAddr(keys.recipient.publicKey())]);
const hx = (u8) => Buffer.from(u8).toString("hex");

console.log("\n== on-chain verification ==");
console.log("state root (genesis):", hx(root.value), root.value && hx(root.value) === GENESIS ? "OK" : "MISMATCH");
console.log("commitment          :", hx(commit.value), hx(commit.value) === COMMIT ? "OK" : "MISMATCH");
console.log("warrant USDW balance:", bal.value?.toString());
console.log("recipient USDW bal  :", rbal.value?.toString());

const cfg = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId: warrantId,
  token: tokenId,
  tokenCode: "USDW",
  recipient: keys.recipient.publicKey(),
  oraclePubKey: ORACLE.oraclePubKey,
  signatureHex: ORACLE.signatureHex,
  messageHex: ORACLE.messageHex,
  commitmentHex: COMMIT,
  genesisRootHex: GENESIS,
  price: ORACLE.price, timestamp: ORACLE.timestamp,
  mandate: { maxPerTx: "100", maxPosition: "1000", drawdownLimit: "100" },
  book: { position: "100", peakEquity: "1000" },
};
fs.writeFileSync(outConfig, JSON.stringify(cfg, null, 2));
fs.writeFileSync(outKeys, JSON.stringify({
  admin: keys.admin.secret(), adminPub: keys.admin.publicKey(),
  recipient: keys.recipient.secret(), recipientPub: keys.recipient.publicKey(),
}, null, 2));
console.log("\nwrote", outConfig, "and", outKeys);
console.log("warrant:", explorerC(warrantId));
console.log("token  :", explorerC(tokenId));
