import * as S from "@stellar/stellar-sdk";

export function addressIdentity(strkey) {
  const address = new S.Address(strkey);
  const bytes = address.toBuffer();
  if (bytes.length !== 32) {
    throw new Error(`expected 32 address payload bytes, got ${bytes.length}`);
  }
  const recipientType = address.type === "account" ? 0n : address.type === "contract" ? 1n : null;
  if (recipientType === null) {
    throw new Error(`unsupported Stellar address type: ${address.type}`);
  }
  const recipientHi = BigInt(`0x${bytes.subarray(0, 16).toString("hex")}`);
  const recipientLo = BigInt(`0x${bytes.subarray(16, 32).toString("hex")}`);
  return {
    recipientType: recipientType.toString(),
    bytesHex: bytes.toString("hex"),
    recipientHi: recipientHi.toString(),
    recipientLo: recipientLo.toString(),
  };
}
