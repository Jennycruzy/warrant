// Complete circom(snarkjs) -> Soroban byte encoder for BLS12-381 (big-endian),
// matching the on-chain VerificationKey/Proof/PublicSignals layout.
const FQ = 48, U256 = 32;
const dec = (v, n) => {
  const x = BigInt(String(v).trim());
  if (x < 0n) throw new Error("negative field value");
  if (x >= (1n << BigInt(n * 8))) throw new Error(`value > ${n} bytes`);
  return x.toString(16).padStart(n * 2, "0");
};
const u32be = (v) => v.toString(16).padStart(8, "0");
const g1 = (p) => dec(p[0], FQ) + dec(p[1], FQ);
const g2 = (p) => dec(p[0][1], FQ) + dec(p[0][0], FQ) + dec(p[1][1], FQ) + dec(p[1][0], FQ);

export const proofToHex = (pr) => (g1(pr.pi_a) + g2(pr.pi_b) + g1(pr.pi_c)).toLowerCase();
export const publicToHex = (sig) => (u32be(sig.length) + sig.map((s) => dec(s, U256)).join("")).toLowerCase();
export function vkToHex(vk) {
  let out = g1(vk.vk_alpha_1) + g2(vk.vk_beta_2) + g2(vk.vk_gamma_2) + g2(vk.vk_delta_2);
  out += u32be(vk.IC.length);
  for (const p of vk.IC) out += g1(p);
  return out.toLowerCase();
}
