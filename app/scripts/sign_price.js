// Generate a real Ed25519 oracle keypair and sign price || timestamp.
// The contract verifies the same 16-byte big-endian message natively.
//
// Usage: node sign_price.js <price> <timestamp>
const crypto = require("crypto");

const [price, timestamp] = process.argv.slice(2);
if (price === undefined || timestamp === undefined) {
  console.error("usage: node sign_price.js <price> <timestamp>");
  process.exit(1);
}

function u64be(value) {
  const n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(n);
  return buf;
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicDer = publicKey.export({ type: "spki", format: "der" });
const publicKeyRaw = publicDer.subarray(publicDer.length - 32);
const message = Buffer.concat([u64be(price), u64be(timestamp)]);
const signature = crypto.sign(null, message, privateKey);

console.log(JSON.stringify({
  publicKeyHex: publicKeyRaw.toString("hex"),
  messageHex: message.toString("hex"),
  signatureHex: signature.toString("hex"),
  price: String(price),
  timestamp: String(timestamp),
}));
