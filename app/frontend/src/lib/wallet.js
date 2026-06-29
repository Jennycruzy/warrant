// Real Stellar wallet connection (Freighter). The browser NEVER holds a secret key.
// Every transaction is signed by the user's wallet extension after explicit approval.
import {
  isConnected,
  requestAccess,
  getAddress,
  getNetwork,
  getNetworkDetails,
  signTransaction,
} from "@stellar/freighter-api";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

// Freighter v4 returns { value, error } shaped objects; unwrap and surface errors plainly.
function unwrap(res, field) {
  if (!res) throw new Error("No response from wallet.");
  if (res.error) throw new Error(typeof res.error === "string" ? res.error : res.error.message || "Wallet error");
  return field ? res[field] : res;
}

// True only when the Freighter extension is actually installed in this browser.
export async function isWalletAvailable() {
  try {
    const res = await isConnected();
    return Boolean(res?.isConnected);
  } catch {
    return false;
  }
}

// Ask the user to grant this site access, then return their public key.
export async function connectWallet() {
  if (!(await isWalletAvailable())) {
    throw new Error("Install Freighter or use a Stellar-compatible wallet, then reload.");
  }
  const access = await requestAccess();
  const address = unwrap(access, "address");
  if (!address) throw new Error("Wallet did not return a public key.");
  return address;
}

export async function getWalletPublicKey() {
  const res = await getAddress();
  return unwrap(res, "address");
}

// Returns { network, networkPassphrase } as reported by the wallet.
export async function getWalletNetwork() {
  const details = await getNetworkDetails();
  const d = unwrap(details);
  return { network: d.network, networkPassphrase: d.networkPassphrase };
}

export async function isWalletOnTestnet() {
  try {
    const net = await getNetwork();
    const n = unwrap(net);
    return (n.network || "").toUpperCase() === "TESTNET" || n.networkPassphrase === TESTNET_PASSPHRASE;
  } catch {
    return false;
  }
}

export async function isWalletConnected() {
  try {
    const res = await getAddress();
    return Boolean(res?.address);
  } catch {
    return false;
  }
}

// Ask the wallet to sign a transaction envelope (XDR). Returns the signed XDR string.
// This is the ONLY signing path in the app — no secret key ever touches the browser.
export async function signTransactionXdr(xdr, networkPassphrase = TESTNET_PASSPHRASE) {
  const res = await signTransaction(xdr, { networkPassphrase });
  const signed = unwrap(res, "signedTxXdr");
  if (!signed) throw new Error("Wallet returned no signed transaction.");
  return signed;
}

// Freighter has no programmatic disconnect; we just drop the address from app state.
export function disconnectWallet() {
  return true;
}
