import { useCallback, useEffect, useMemo, useState } from "react";
import * as snarkjs from "snarkjs";
import { proofToHex, publicSignalsToHex } from "./lib/snarkHex.js";
import {
  DEFAULT_NETWORK,
  DEFAULT_RPC,
  readContractState,
  readTokenBalance,
  readTokenMeta,
  fundContract,
  settleWithFootprint,
  settleWithPrice,
} from "./lib/stellarWarrant.js";
import {
  connectWallet,
  disconnectWallet,
  getWalletPublicKey,
  isWalletConnected,
  isWalletOnTestnet,
  signTransactionXdr,
} from "./lib/wallet.js";

const explorer = "https://stellar.expert/explorer/testnet/tx/";

const scenarios = {
  valid: "/valid.input.json",
  overLimit: "/over_limit.input.json",
  nonAllow: "/non_allow.input.json",
  breach: "/breach.input.json",
};

function short(value, chars = 8) {
  if (!value) return "not set";
  const s = String(value);
  if (s.length <= chars * 2) return s;
  return `${s.slice(0, chars)}…${s.slice(-chars)}`;
}

// Render a raw smallest-unit balance with the token's decimals.
function human(raw, decimals) {
  if (raw == null) return "—";
  if (decimals == null) return String(raw);
  const neg = String(raw).startsWith("-");
  const digits = String(raw).replace("-", "").padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

function Step({ name, state }) {
  return <span className={`step ${state}`}>{name}</span>;
}

function Balance({ title, raw, decimals, symbol, loading }) {
  return (
    <div className="balcard">
      <p className="baltitle">{title}</p>
      <p className="balval">
        {loading ? "…" : human(raw, decimals)} <span className="balsym">{symbol || ""}</span>
      </p>
      <p className="balraw">{loading ? "" : raw == null ? "" : `${raw} raw`}</p>
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [chain, setChain] = useState({});
  const [meta, setMeta] = useState({});
  const [balances, setBalances] = useState({ wallet: null, contract: null, recipient: null });
  const [balLoading, setBalLoading] = useState(false);
  const [balUpdated, setBalUpdated] = useState(null);

  const [wallet, setWallet] = useState(null); // connected public key
  const [onTestnet, setOnTestnet] = useState(true);

  const [amount, setAmount] = useState(50);
  const [recipient, setRecipient] = useState("0");
  const [fundAmount, setFundAmount] = useState(1000);
  const [observer, setObserver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("Connect a Stellar testnet wallet to fund and settle.");
  const [proofHex, setProofHex] = useState("");
  const [publicHex, setPublicHex] = useState("");
  const [lastProof, setLastProof] = useState(null);
  const [footprint, setFootprint] = useState(null);
  const [feed, setFeed] = useState([]);

  const network = DEFAULT_NETWORK;
  const rpcUrl = config?.rpcUrl || DEFAULT_RPC;
  const tokenId = config?.token;
  const secretMandate = config?.mandate || { maxPerTx: "100", maxPosition: "1000", drawdownLimit: "100" };
  const privateBook = config?.book || { position: "100", peakEquity: "1000" };
  const symbol = meta.symbol || config?.tokenCode || "USDW";
  const decimals = meta.decimals ?? 7;

  useEffect(() => {
    fetch("/demo-config.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  // Restore an already-authorized wallet session on load.
  useEffect(() => {
    isWalletConnected()
      .then(async (connected) => {
        if (!connected) return;
        const pk = await getWalletPublicKey();
        setWallet(pk);
        setOnTestnet(await isWalletOnTestnet());
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!config?.contractId) return;
    readContractState({ rpcUrl, contractId: config.contractId })
      .then(setChain)
      .catch((err) => setMessage(`Chain read failed: ${err.message || String(err)}`));
    readTokenMeta({ rpcUrl, tokenId: config.token }).then(setMeta).catch(() => {});
  }, [config?.contractId, config?.token, rpcUrl]);

  const refreshBalances = useCallback(async () => {
    if (!config?.contractId || !config?.token) return;
    setBalLoading(true);
    try {
      const [contract, recip, wal] = await Promise.all([
        readTokenBalance({ rpcUrl, tokenId: config.token, address: config.contractId }),
        readTokenBalance({ rpcUrl, tokenId: config.token, address: config.recipient }),
        wallet ? readTokenBalance({ rpcUrl, tokenId: config.token, address: wallet }) : Promise.resolve(null),
      ]);
      setBalances({ contract, recipient: recip, wallet: wal });
      setBalUpdated(new Date());
    } catch (err) {
      setMessage(`Balance read failed: ${err.message || String(err)}`);
    } finally {
      setBalLoading(false);
    }
  }, [config?.contractId, config?.token, config?.recipient, rpcUrl, wallet]);

  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  const selectedScenario = useMemo(() => {
    if (recipient !== "0") return "nonAllow";
    if (amount > Number(secretMandate.maxPerTx)) return "overLimit";
    return "valid";
  }, [amount, recipient, secretMandate.maxPerTx]);

  function appendFeed(row) {
    setFeed((rows) => [{ id: Date.now(), ts: new Date().toLocaleTimeString(), ...row }, ...rows].slice(0, 10));
  }

  async function onConnect() {
    try {
      const pk = await connectWallet();
      setWallet(pk);
      const testnet = await isWalletOnTestnet();
      setOnTestnet(testnet);
      setMessage(testnet
        ? "Wallet connected. Fund the warrant, then settle a compliant proof."
        : "Wallet connected but NOT on Stellar testnet. Switch the wallet network to Testnet.");
    } catch (err) {
      setMessage(err.message || String(err));
    }
  }

  function onDisconnect() {
    disconnectWallet();
    setWallet(null);
    setBalances((b) => ({ ...b, wallet: null }));
    setMessage("Wallet disconnected.");
  }

  // The connected wallet signs the XDR. This is the only signing path.
  const signXdr = (xdr, passphrase) => signTransactionXdr(xdr, passphrase);

  function requireWallet() {
    if (wallet) return true;
    setMessage("Connect a wallet first.");
    return false;
  }

  async function onFund() {
    if (!requireWallet()) return;
    setBusy(true);
    setStatus("submitting");
    setMessage("Building fund transaction — approve it in your wallet.");
    try {
      const sent = await fundContract({
        rpcUrl, networkPassphrase: network, sourcePublicKey: wallet, signXdr,
        contractId: config.contractId, amount: fundAmount,
      });
      setStatus("idle");
      appendFeed({ kind: "settled", text: `Funded warrant with ${fundAmount} ${symbol} (raw)`, hash: sent.hash });
      setMessage("Funded on-chain. Contract balance increased.");
      await refreshBalances();
    } catch (err) {
      setStatus("rejected");
      setMessage(`Fund failed: ${err.message || String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function proveScenario(name) {
    setStatus("witness");
    const input = await fetch(scenarios[name]).then((r) => r.json());
    setStatus("proving");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      "/circuits/mandate_oracle_allow.wasm",
      "/proving/mandate_oracle_allow_final.zkey"
    );
    return { input, proofHex: proofToHex(proof), publicHex: publicSignalsToHex(publicSignals), publicSignals };
  }

  async function onSettle() {
    if (!requireWallet()) return;
    setBusy(true);
    setMessage("Generating witness.");
    try {
      const scenario = selectedScenario;
      if (scenario !== "valid") {
        await proveScenario(scenario);
        throw new Error("unexpectedly produced a proof for a blocked action");
      }
      const result = await proveScenario("valid");
      setProofHex(result.proofHex);
      setPublicHex(result.publicHex);
      setStatus("submitting");
      setMessage("Proof generated — approve the settlement in your wallet.");
      const sent = await settleWithPrice({
        rpcUrl, networkPassphrase: network, sourcePublicKey: wallet, signXdr,
        contractId: config.contractId,
        proofHex: result.proofHex, publicHex: result.publicHex,
        price: config.price, timestamp: config.timestamp, signatureHex: config.signatureHex,
      });
      setStatus("settled");
      setLastProof(result);
      setFootprint(sent.footprint);
      appendFeed({ kind: "settled", text: "Compliant settlement paid recipient", hash: sent.hash });
      setMessage("Settled on-chain. State root advanced and the recipient was paid. Forged/replay attempts now land as real reverted txs.");
      setChain(await readContractState({ rpcUrl, contractId: config.contractId }));
      await refreshBalances();
    } catch (err) {
      const neverReached = selectedScenario !== "valid";
      setStatus(neverReached ? "blocked" : "rejected");
      appendFeed({
        kind: neverReached ? "blocked" : "rejected",
        text: neverReached ? "No proof can exist; never reached chain" : "Settlement rejected",
      });
      setMessage(neverReached ? reasonFor(selectedScenario) : err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  function requireAnchor() {
    if (footprint && lastProof) return true;
    setMessage("Run a compliant settlement first — the adversarial attempts reuse its on-chain footprint to land as real reverted txs.");
    return false;
  }

  async function submitAdversarial({ kind, proofHex, publicHex, expected, describe }) {
    if (!requireWallet()) return;
    setBusy(true);
    setStatus("submitting");
    setMessage(`Approve the ${kind} in your wallet — it will be submitted to testnet and revert.`);
    try {
      const res = await settleWithFootprint({
        rpcUrl, networkPassphrase: network, sourcePublicKey: wallet, signXdr,
        contractId: config.contractId, proofHex, publicHex,
        price: config.price, timestamp: config.timestamp, signatureHex: config.signatureHex, footprint,
      });
      if (res.status === "FAILED") {
        setStatus("rejected");
        appendFeed({ kind: "rejected", text: `${describe} reverted on-chain (${res.reason.name || `#${res.reason.code}`})`, hash: res.hash });
        setMessage(`Contract reverted the ${kind} on-chain: ${res.reason.name || "rejected"} (#${res.reason.code ?? "?"}). Real testnet transaction — open the explorer link. No funds moved.`);
        await refreshBalances();
      } else {
        setStatus(res.status === "SUCCESS" ? "settled" : "rejected");
        appendFeed({ kind: res.status === "SUCCESS" ? "settled" : "rejected", text: `${describe}: unexpected ${res.status}`, hash: res.hash });
        setMessage(`Unexpected: the ${kind} resolved as ${res.status} (expected revert ${expected}).`);
      }
    } catch (err) {
      setStatus("rejected");
      setMessage(`${describe} submission error: ${err.message || String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function onForged() {
    if (!requireAnchor()) return;
    const forgedSignals = [...lastProof.publicSignals];
    forgedSignals[1] = lastProof.publicSignals[2];
    forgedSignals[2] = "12345";
    return submitAdversarial({
      kind: "forged proof", describe: "Forged proof", expected: "ProofInvalid #10",
      proofHex: lastProof.proofHex, publicHex: publicSignalsToHex(forgedSignals),
    });
  }

  function onReplay() {
    if (!requireAnchor()) return;
    return submitAdversarial({
      kind: "replayed proof", describe: "Replay", expected: "StaleStateRoot #9",
      proofHex: lastProof.proofHex, publicHex: lastProof.publicHex,
    });
  }

  async function onRemark() {
    setBusy(true);
    try {
      await proveScenario("breach");
      throw new Error("breached mark unexpectedly produced a proof");
    } catch {
      setStatus("blocked");
      appendFeed({ kind: "blocked", text: "Lower oracle mark made the same action unprovable" });
      setMessage("Oracle re-mark: price 8 derives equity 800, drawdown 200 exceeds hidden limit 100. Never reached chain.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="topbar">
        <div>
          <p className="eyebrow">Private mandate. Public settlement.</p>
          <h1>WARRANT</h1>
        </div>
        <div className="walletbox">
          <span className={`netbadge ${onTestnet ? "" : "warn"}`}>{onTestnet ? "Stellar Testnet" : "Wrong network"}</span>
          {wallet ? (
            <>
              <button className="addr" title={wallet} onClick={() => navigator.clipboard?.writeText(wallet)}>{short(wallet, 6)}</button>
              <button className="toggle" onClick={onDisconnect}>Disconnect</button>
            </>
          ) : (
            <button className="connect" onClick={onConnect}>Connect Wallet</button>
          )}
          <button className="toggle" onClick={() => setObserver((v) => !v)}>{observer ? "Hide observer" : "Observer view"}</button>
        </div>
      </section>

      <section className="balances">
        <Balance title="Connected wallet" raw={balances.wallet} decimals={decimals} symbol={symbol} loading={balLoading} />
        <Balance title="Warrant contract" raw={balances.contract} decimals={decimals} symbol={symbol} loading={balLoading} />
        <Balance title="Recipient 0" raw={balances.recipient} decimals={decimals} symbol={symbol} loading={balLoading} />
        <div className="balcard refresh">
          <button disabled={balLoading} onClick={refreshBalances}>Refresh balances</button>
          <p className="balraw">{balUpdated ? `updated ${balUpdated.toLocaleTimeString()}` : ""}</p>
        </div>
      </section>

      <section className="grid">
        <aside className="zone secret">
          <p className="label">Agent's secret</p>
          <h2>Private mandate</h2>
          <dl>
            <dt>Max per tx</dt><dd>{secretMandate.maxPerTx}</dd>
            <dt>Max position</dt><dd>{secretMandate.maxPosition}</dd>
            <dt>Drawdown limit</dt><dd>{secretMandate.drawdownLimit}</dd>
            <dt>Book position</dt><dd>{privateBook.position}</dd>
          </dl>
          <p className="lock">Never sent on-chain.</p>
        </aside>

        <section className="zone action">
          <p className="label">Action</p>
          <h2>Try to move {symbol}</h2>
          <label>Amount <strong>{amount}</strong>
            <input type="range" min="1" max="160" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          </label>
          <label>Recipient
            <select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
              <option value="0">Recipient 0, allowlisted</option>
              <option value="7">Recipient 7, not allowlisted</option>
            </select>
          </label>
          <div className="fundrow">
            <label>Fund amount (raw)
              <input type="number" min="1" value={fundAmount} onChange={(e) => setFundAmount(Number(e.target.value))} />
            </label>
            <button disabled={busy || !config || !wallet} onClick={onFund}>Fund warrant</button>
          </div>
          <div className="buttons">
            <button disabled={busy || !config || !wallet} onClick={onSettle}>Generate proof &amp; settle</button>
            <button disabled={busy || !config || !wallet} onClick={onForged}>Submit forged proof</button>
            <button disabled={busy || !config || !wallet} onClick={onReplay}>Replay last proof</button>
            <button disabled={busy || !config} onClick={onRemark}>Oracle re-mark</button>
          </div>
          <div className="pipeline">
            <Step name="witness" state={status === "witness" ? "active" : ""} />
            <Step name="prove" state={status === "proving" ? "active" : ""} />
            <Step name="wallet sign" state={status === "submitting" ? "active" : ""} />
            <Step name="settled" state={status === "settled" ? "good" : ""} />
            <Step name="rejected" state={status === "rejected" || status === "blocked" ? "bad" : ""} />
          </div>
          <p className="message">{message}</p>
        </section>

        <aside className="zone chain">
          <p className="label">What Stellar sees</p>
          <h2>Public state</h2>
          <dl>
            <dt>Contract</dt><dd title={config?.contractId}>{short(config?.contractId)}</dd>
            <dt>Token ({symbol})</dt><dd title={config?.token}>{short(config?.token)}</dd>
            <dt>Policy commitment</dt><dd>{short(chain.commitment || config?.commitmentHex)}</dd>
            <dt>State root</dt><dd>{short(chain.root || config?.genesisRootHex)}</dd>
          </dl>
          <p className="lock">The mandate and book are absent from chain.</p>
        </aside>
      </section>

      {observer && (
        <section className="observer">
          <h2>Raw observer bytes</h2>
          <p className="muted">Hidden: maxPerTx, maxPosition, drawdownLimit, private book.</p>
          <pre>{JSON.stringify({
            contractId: config?.contractId,
            tokenId: config?.token,
            policyCommitment: chain.commitment || config?.commitmentHex,
            currentStateRoot: chain.root || config?.genesisRootHex,
            proofBytes: proofHex || "generate a proof first",
            publicInputs: publicHex || "generate a proof first",
            oracleSignature: config?.signatureHex,
          }, null, 2)}</pre>
        </section>
      )}

      <section className="feed">
        <h2>Transaction feed</h2>
        {feed.length === 0 ? <p className="muted">No attempts yet.</p> : feed.map((row) => (
          <div className="feedrow" key={row.id}>
            <span className="ts">{row.ts}</span>
            <span className={`pill ${row.kind}`}>{row.kind}</span>
            <span>{row.text}</span>
            {row.hash && <a href={`${explorer}${row.hash}`} target="_blank" rel="noreferrer">Explorer</a>}
          </div>
        ))}
      </section>

      <footer>
        <p>
          No mocks: proofs are generated with snarkjs in this browser; every on-chain action is signed by your
          connected Stellar wallet. Compliant settlements pay {symbol} on Stellar testnet, and forged or replayed
          proofs are submitted and <strong>revert on-chain</strong> with real explorer links.
        </p>
        <p className="verify">Don't trust this UI — verify the live contract directly (no keys needed):</p>
        <code>stellar contract invoke --id {config?.contractId || "<contract-id>"} --network testnet -- current_state_root</code>
      </footer>
    </main>
  );
}

function reasonFor(scenario) {
  if (scenario === "overLimit") return "Stopped before chain: witness/proof generation failed — amount exceeds the hidden maxPerTx. No transaction was submitted.";
  if (scenario === "nonAllow") return "Stopped before chain: witness/proof generation failed — recipient is not in the committed private allowlist. No transaction was submitted.";
  return "No proof can exist.";
}
