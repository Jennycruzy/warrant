import * as StellarSdk from "@stellar/stellar-sdk";
import { hexToBytes } from "./snarkHex.js";

const rpcNamespace = StellarSdk.SorobanRpc || StellarSdk.rpc;

export const DEFAULT_NETWORK = "Test SDF Network ; September 2015";
export const DEFAULT_RPC = "https://soroban-testnet.stellar.org";

function serverFor(rpcUrl) {
  return new rpcNamespace.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
}

function keypairFromSecret(secret) {
  if (!secret || secret.includes("REPLACE_WITH")) throw new Error("Set VITE_SOURCE_SECRET to a funded testnet secret key.");
  return StellarSdk.Keypair.fromSecret(secret.trim());
}

function scBytes(hex) {
  return StellarSdk.xdr.ScVal.scvBytes(hexToBytes(hex));
}

function scBytesN(hex) {
  return StellarSdk.nativeToScVal(hexToBytes(hex), { type: "bytes" });
}

function scU64(value) {
  return StellarSdk.nativeToScVal(BigInt(value), { type: "u64" });
}

async function submitInvoke({ rpcUrl, networkPassphrase, sourceSecret, contractId, fn, args }) {
  const server = serverFor(rpcUrl);
  const source = keypairFromSecret(sourceSecret);
  const account = await server.getAccount(source.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.invokeContractFunction({ contract: contractId, function: fn, args }))
    .setTimeout(60)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (rpcNamespace.Api?.isSimulationError?.(simulated) || simulated.error) {
    const err = simulated.error || simulated;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  }

  const prepared = StellarSdk.assembleTransaction(tx, simulated).build();
  prepared.sign(source);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(JSON.stringify(sent.errorResult || sent));
  return sent;
}

export async function readContractState({ rpcUrl, contractId }) {
  if (!contractId) return {};
  const server = serverFor(rpcUrl);
  async function simulate(fn) {
    const kp = StellarSdk.Keypair.random();
    const account = new StellarSdk.Account(kp.publicKey(), "0");
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: DEFAULT_NETWORK,
    })
      .addOperation(StellarSdk.Operation.invokeContractFunction({ contract: contractId, function: fn, args: [] }))
      .setTimeout(30)
      .build();
    const res = await server.simulateTransaction(tx);
    return res.result?.retval ? StellarSdk.scValToNative(res.result.retval) : "";
  }
  const [root, commitment] = await Promise.all([simulate("current_state_root"), simulate("policy_commitment")]);
  return { root: String(root), commitment: String(commitment) };
}

export async function settleWithPrice(opts) {
  return submitInvoke({
    ...opts,
    fn: "settle_with_price",
    args: [
      scBytes(opts.proofHex),
      scBytes(opts.publicHex),
      scU64(opts.price),
      scU64(opts.timestamp),
      scBytesN(opts.signatureHex),
    ],
  });
}

export async function settle(opts) {
  return submitInvoke({
    ...opts,
    fn: "settle",
    args: [scBytes(opts.proofHex), scBytes(opts.publicHex)],
  });
}
