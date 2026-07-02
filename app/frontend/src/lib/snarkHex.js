const BYTE_LEN_FQ = 48;
const BYTE_LEN_U256 = 32;

function toFixedHexFromDecimal(value, byteLen) {
  const v = BigInt(String(value).trim());
  if (v < 0n) throw new Error("negative field value");
  const max = 1n << BigInt(byteLen * 8);
  if (v >= max) throw new Error(`value does not fit in ${byteLen} bytes`);
  return v.toString(16).padStart(byteLen * 2, "0");
}

function u32beHex(value) {
  return value.toString(16).padStart(8, "0");
}

function g1Hex(point) {
  return toFixedHexFromDecimal(point[0], BYTE_LEN_FQ) + toFixedHexFromDecimal(point[1], BYTE_LEN_FQ);
}

function g2Hex(point) {
  const [x, y] = point;
  return (
    toFixedHexFromDecimal(x[1], BYTE_LEN_FQ) +
    toFixedHexFromDecimal(x[0], BYTE_LEN_FQ) +
    toFixedHexFromDecimal(y[1], BYTE_LEN_FQ) +
    toFixedHexFromDecimal(y[0], BYTE_LEN_FQ)
  );
}

export function proofToHex(proof) {
  return (g1Hex(proof.pi_a) + g2Hex(proof.pi_b) + g1Hex(proof.pi_c)).toLowerCase();
}

export function publicSignalsToHex(publicSignals) {
  return (
    u32beHex(publicSignals.length) +
    publicSignals.map((s) => toFixedHexFromDecimal(s, BYTE_LEN_U256)).join("")
  ).toLowerCase();
}

function cleanHex(value) {
  return String(value || "").trim().toLowerCase().replace(/^0x/, "").replace(/\s+/g, "");
}

export function hexToBytes(hex) {
  const clean = cleanHex(hex);
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  return out;
}
