import { useCallback, useEffect, useMemo, useState } from "react";
import * as snarkjs from "snarkjs";
import { proofToHex, publicSignalsToHex } from "./lib/snarkHex.js";
import {
  DEFAULT_NETWORK,
  DEFAULT_RPC,
  readContractState,
  readTokenBalance,
  readTokenMeta,
  borrowSettleFootprint,
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

function integerOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInteger(value, min, max, fallback = min) {
  const n = integerOr(value, fallback);
  return Math.min(max, Math.max(min, n));
}

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
  const [seq, setSeq] = useState(null); // chained-settlement manifest
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
  const addressBound = config?.recipientBinding === "address";
  const circuitWasm = config?.circuitWasm || "/circuits/mandate_oracle_allow.wasm";
  const provingKey = config?.provingKey || "/proving/mandate_oracle_allow_final.zkey";
  const recipientOptions = useMemo(() => {
    if (Array.isArray(config?.recipients) && config.recipients.length > 0) return config.recipients;
    return [{ id: "0", label: "Recipient 0, allowlisted", address: config?.recipient, type: 0 }];
  }, [config?.recipients, config?.recipient]);
  const selectedRecipient = recipientOptions.find((r) => String(r.id) === String(recipient));
  const selectedRecipientAddress = selectedRecipient?.address || config?.recipient;
  const secretMandate = config?.mandate || { maxPerTx: "100", maxPosition: "1000", drawdownLimit: "100" };
  const privateBook = config?.book || { position: "100", peakEquity: "1000" };
  const symbol = meta.symbol || config?.tokenCode || "USDW";
  const decimals = meta.decimals ?? 7;
  const maxPerTx = Number(secretMandate.maxPerTx);
  const sequenceAmount = Number(seq?.amount ?? 50);
  const sequenceCount = seq?.count ?? 0;
  const nextPosition = seq?.settlements?.[0]?.nextPosition;
  const amountMatchesSequence = amount === sequenceAmount;

  useEffect(() => {
    fetch("/demo-config.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(setConfig)
      .catch(() => setConfig(null));
    fetch("/seq/manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(setSeq)
      .catch(() => setSeq(null));
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
        readTokenBalance({ rpcUrl, tokenId: config.token, address: selectedRecipientAddress }),
        wallet ? readTokenBalance({ rpcUrl, tokenId: config.token, address: wallet }) : Promise.resolve(null),
      ]);
      setBalances({ contract, recipient: recip, wallet: wal });
      setBalUpdated(new Date());
    } catch (err) {
      setMessage(`Balance read failed: ${err.message || String(err)}`);
    } finally {
      setBalLoading(false);
    }
  }, [config?.contractId, config?.token, selectedRecipientAddress, rpcUrl, wallet]);

  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  const selectedScenario = useMemo(() => {
    if (addressBound ? !selectedRecipient : recipient !== "0") return "nonAllow";
    if (amount > maxPerTx) return "overLimit";
    if (!seq?.settlements?.length) return "sequenceUnavailable";
    if (amount !== sequenceAmount) return "unsupportedAmount";
    return "valid";
  }, [addressBound, amount, maxPerTx, recipient, selectedRecipient, seq?.settlements?.length, sequenceAmount]);

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

  async function requireWallet() {
    if (!config?.contractId || !config?.token) {
      setMessage("Deployment config is not loaded.");
      return false;
    }
    if (!wallet) {
      setMessage("Connect a wallet first.");
      return false;
    }
    const testnet = await isWalletOnTestnet();
    setOnTestnet(testnet);
    if (!testnet) {
      setMessage("Switch the wallet network to Stellar Testnet before signing.");
      return false;
    }
    return true;
  }

  async function onFund() {
    if (!(await requireWallet())) return;
    const rawAmount = clampInteger(fundAmount, 1, Number.MAX_SAFE_INTEGER, 1000);
    setFundAmount(rawAmount);
    setBusy(true);
    setStatus("submitting");
    setMessage("Building fund transaction — approve it in your wallet.");
    try {
      const sent = await fundContract({
        rpcUrl, networkPassphrase: network, sourcePublicKey: wallet, signXdr,
        contractId: config.contractId, amount: rawAmount,
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
      circuitWasm,
      provingKey
    );
    return { input, proofHex: proofToHex(proof), publicHex: publicSignalsToHex(publicSignals), publicSignals };
  }

  function recipientForEntry(entry) {
    if (!addressBound) return null;
    return recipientOptions.find((r) => String(r.id) === String(entry.recipientId ?? entry.recipient));
  }

  async function proveSequenceEntry(entry) {
    setStatus("witness");
    const input = await fetch(`/${entry.file}`).then((r) => r.json());
    setStatus("proving");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      circuitWasm,
      provingKey
    );
    const entryRecipient = recipientForEntry(entry);
    const recipientAddress = addressBound ? entryRecipient?.address : undefined;
    if (addressBound && !recipientAddress) {
      throw new Error("Selected sequence entry does not have a configured recipient address.");
    }
    return { proofHex: proofToHex(proof), publicHex: publicSignalsToHex(publicSignals), publicSignals, recipientAddress };
  }

  async function prepareCurrentAnchor({ purpose, entryPredicate = () => true }) {
    setMessage(`Generating a current-root proof for ${purpose}.`);
    const live = await readContractState({ rpcUrl, contractId: config.contractId });
    setChain(live);
    const liveRoot = (live.root || "").toLowerCase();
    const entry = seq?.settlements?.find((s) => s.prevRootHex.toLowerCase() === liveRoot && entryPredicate(s));
    if (!entry) {
      throw new Error(`No current-root proof is available for ${purpose}. Reset the demo or use the recipient whose next sequence entry matches the live root.`);
    }
    const result = await proveSequenceEntry(entry);
    setStatus("simulating");
    setMessage(`Borrowing Soroban resources for ${purpose}; no valid settlement is submitted.`);
    const borrowed = await borrowSettleFootprint({
      rpcUrl, networkPassphrase: network, sourcePublicKey: wallet,
      contractId: config.contractId,
      proofHex: result.proofHex, publicHex: result.publicHex,
      recipientAddress: result.recipientAddress,
      price: config.price, timestamp: config.timestamp, signatureHex: config.signatureHex,
    });
    setProofHex(result.proofHex);
    setPublicHex(result.publicHex);
    setLastProof(result);
    setFootprint(borrowed);
    return { ...result, entry, footprint: borrowed };
  }

  async function onSettle() {
    if (!(await requireWallet())) return;
    setBusy(true);
    setMessage("Generating witness.");
    try {
      const scenario = selectedScenario;
      if (scenario !== "valid") {
        if (scenario === "overLimit" || scenario === "nonAllow") {
          await proveScenario(scenario);
        }
        throw new Error("unexpectedly produced a proof for a blocked action");
      }
      // Chained settlements: each precomputed input extends the previous one's
      // state root, so the SAME contract accepts many compliant settlements in a
      // row. Match the current on-chain root to the input that extends it; if none
      // matches, the agent has reached the mandate cap (no further proof exists).
      const live = await readContractState({ rpcUrl, contractId: config.contractId });
      setChain(live);
      const liveRoot = (live.root || "").toLowerCase();
      const entry = seq?.settlements?.find((s) => {
        const rootMatches = s.prevRootHex.toLowerCase() === liveRoot;
        if (!addressBound) return rootMatches;
        return rootMatches && String(s.recipientId ?? s.recipient) === String(recipient);
      });
      if (!entry) {
        setStatus("blocked");
        appendFeed({ kind: "blocked", text: "All chained settlements used on this deployment" });
        setMessage(
          `All ${seq?.count ?? "demo"} compliant settlements for this deployment have been performed — the agent's position has reached the private mandate cap, so no further compliant proof exists (the position/drawdown limit working as designed). Forged, replay, over-limit, and non-allowlisted attempts still work. Operator: run \`node app/scripts/sdk/setup_addr_demo.mjs\` to mint a fresh contract.`
        );
        return;
      }
      const result = await proveSequenceEntry(entry);
      setProofHex(result.proofHex);
      setPublicHex(result.publicHex);
      setStatus("submitting");
      setMessage(`Settlement #${entry.index} of ${seq.count} — proof generated, approve it in your wallet.`);
      const sent = await settleWithPrice({
        rpcUrl, networkPassphrase: network, sourcePublicKey: wallet, signXdr,
        contractId: config.contractId,
        proofHex: result.proofHex, publicHex: result.publicHex,
        recipientAddress: result.recipientAddress,
        price: config.price, timestamp: config.timestamp, signatureHex: config.signatureHex,
      });
      setStatus("settled");
      setLastProof(result);
      setFootprint(sent.footprint);
      appendFeed({ kind: "settled", text: `Compliant settlement #${entry.index} of ${seq.count} paid recipient`, hash: sent.hash });
      const remaining = seq.count - entry.index;
      setMessage(`Settlement #${entry.index} of ${seq.count} on-chain — state root advanced and the recipient was paid.${remaining > 0 ? ` ${remaining} more compliant settlement${remaining === 1 ? "" : "s"} can be chained — click again.` : " The agent has now reached the mandate cap."} Forged/replay attempts land as real reverted txs.`);
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

  async function submitAdversarial({ kind, proofHex, publicHex, expected, describe, recipientAddress = lastProof?.recipientAddress, footprintOverride, skipWalletCheck = false, manageBusy = true }) {
    if (!skipWalletCheck && !(await requireWallet())) return;
    const borrowedFootprint = footprintOverride || footprint;
    if (manageBusy) setBusy(true);
    setStatus("submitting");
    setMessage(`Approve the ${kind} in your wallet — it will be submitted to testnet and revert.`);
    try {
      const res = await settleWithFootprint({
        rpcUrl, networkPassphrase: network, sourcePublicKey: wallet, signXdr,
        contractId: config.contractId, proofHex, publicHex,
        recipientAddress: addressBound ? recipientAddress : undefined,
        price: config.price, timestamp: config.timestamp, signatureHex: config.signatureHex, footprint: borrowedFootprint,
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
      if (manageBusy) setBusy(false);
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

  async function onRedirect() {
    if (!addressBound || !config?.redirectRecipient) {
      setMessage("Redirect testing is only available on the address-bound deployment config.");
      return;
    }
    if (!(await requireWallet())) return;
    setBusy(true);
    try {
      const anchor = await prepareCurrentAnchor({
        purpose: "a redirect attempt",
        entryPredicate: (entry) => String(recipientForEntry(entry)?.type) === "0",
      });
      await submitAdversarial({
        kind: "redirected recipient", describe: "Redirect", expected: "RecipientMismatch #18",
        proofHex: anchor.proofHex, publicHex: anchor.publicHex,
        recipientAddress: config.redirectRecipient,
        footprintOverride: anchor.footprint,
        skipWalletCheck: true,
        manageBusy: false,
      });
    } catch (err) {
      setStatus("rejected");
      setMessage(`Redirect setup error: ${err.message || String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onTypeConfusion() {
    if (!addressBound) {
      setMessage("Type-confusion testing is only available on the address-bound deployment config.");
      return;
    }
    if (!(await requireWallet())) return;
    setBusy(true);
    try {
      const anchor = await prepareCurrentAnchor({ purpose: "a type-confusion attempt" });
      const provenType = String(anchor.publicSignals?.[4]);
      const opposite = recipientOptions.find((r) => String(r.type) !== provenType);
      if (!opposite?.address) {
        throw new Error("No opposite-type recipient is configured.");
      }
      await submitAdversarial({
        kind: "type-confused recipient", describe: "Type confusion", expected: "RecipientTypeMismatch #19",
        proofHex: anchor.proofHex, publicHex: anchor.publicHex,
        recipientAddress: opposite.address,
        footprintOverride: anchor.footprint,
        skipWalletCheck: true,
        manageBusy: false,
      });
    } catch (err) {
      setStatus("rejected");
      setMessage(`Type-confusion setup error: ${err.message || String(err)}`);
    } finally {
      setBusy(false);
    }
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
          <p className="eyebrow">Custody an autonomous agent cannot break</p>
          <h1>WARRANT</h1>
          <p className="muted">A ZK-enforced private mandate for agents that hold funds. The contract releases {symbol} only after a proof binds the private witness to the public commitment, live root, amount, recipient identity, and signed price.</p>
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
        <Balance title={selectedRecipient?.label || "Selected recipient"} raw={balances.recipient} decimals={decimals} symbol={symbol} loading={balLoading} />
        <div className="balcard refresh">
          <button disabled={balLoading} onClick={refreshBalances}>Refresh balances</button>
          <p className="balraw">{balUpdated ? `updated ${balUpdated.toLocaleTimeString()}` : ""}</p>
        </div>
      </section>

      <section className="grid">
        <aside className="zone secret">
          <p className="label">Demo witness</p>
          <h2>Private inputs</h2>
          <dl>
            <dt>Max per tx</dt><dd>{secretMandate.maxPerTx}</dd>
            <dt>Max position</dt><dd>{secretMandate.maxPosition}</dd>
            <dt>Drawdown limit</dt><dd>{secretMandate.drawdownLimit}</dd>
            <dt>Book position</dt><dd>{privateBook.position}</dd>
            <dt>Signed price</dt><dd>{config?.price ?? "—"}</dd>
          </dl>
          <p className="lock">Loaded locally for the demo; the contract stores only commitments and roots.</p>
        </aside>

        <section className="zone action">
          <p className="label">Action</p>
          <h2>Try to move {symbol}</h2>
          <div className="runmeta">
            <span>Sequence amount <strong>{sequenceAmount || "—"}</strong> raw</span>
            <span>{sequenceCount || "—"} linked proofs</span>
            <span>{nextPosition ? `Next position ${nextPosition}` : "Root matched live"}</span>
          </div>
          <label>Attempt amount <strong className={amountMatchesSequence ? "goodtext" : "warntext"}>{amount}</strong>
            <div className="amountrow">
              <input type="range" min="1" max="160" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
              <input
                type="number"
                min="1"
                max="160"
                step="1"
                value={amount}
                onChange={(e) => setAmount(clampInteger(e.target.value, 1, 160, sequenceAmount || 50))}
              />
            </div>
          </label>
          <label>Recipient
            <select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
              {recipientOptions.map((r) => (
                <option value={r.id} key={r.id}>{r.label || r.address}</option>
              ))}
              <option value={addressBound ? "nonAllow" : "7"}>{addressBound ? "Wrong type, not allowlisted" : "Recipient 7, not allowlisted"}</option>
            </select>
          </label>
          <div className="fundrow">
            <label>Fund amount (raw)
              <input type="number" min="1" step="1" value={fundAmount} onChange={(e) => setFundAmount(clampInteger(e.target.value, 1, Number.MAX_SAFE_INTEGER, 1000))} />
            </label>
            <button disabled={busy || !config || !wallet} onClick={onFund}>Fund warrant</button>
          </div>
          <div className="buttons">
            <button disabled={busy || !config || !wallet} onClick={onSettle}>Generate proof &amp; settle</button>
            <button disabled={busy || !config || !wallet} onClick={onForged}>Submit forged proof</button>
            <button disabled={busy || !config || !wallet} onClick={onReplay}>Replay last proof</button>
            {addressBound && <button disabled={busy || !config || !wallet} onClick={onRedirect}>Redirect recipient</button>}
            {addressBound && <button disabled={busy || !config || !wallet} onClick={onTypeConfusion}>Type confusion</button>}
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
            {addressBound && <><dt>Binding</dt><dd>type + key bytes</dd></>}
            <dt>Policy commitment</dt><dd>{short(chain.commitment || config?.commitmentHex)}</dd>
            <dt>State root</dt><dd>{short(chain.root || config?.genesisRootHex)}</dd>
          </dl>
          <p className="lock">The mandate and book are absent from chain.</p>
        </aside>
      </section>

      {observer && (
        <section className="observer">
          <h2>Raw observer bytes</h2>
          <p className="muted">Not stored on-chain: maxPerTx, maxPosition, drawdownLimit, allowlist root, and private book.</p>
          <pre>{JSON.stringify({
            contractId: config?.contractId,
            tokenId: config?.token,
            policyCommitment: chain.commitment || config?.commitmentHex,
            currentStateRoot: chain.root || config?.genesisRootHex,
            proofBytes: proofHex || "generate a proof first",
            publicInputs: publicHex || "generate a proof first",
            recipientAddress: lastProof?.recipientAddress || selectedRecipientAddress,
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
          No mocks: proofs are generated with snarkjs in this browser, every on-chain action is signed by your
          connected Stellar wallet, and this UI uses the committed fixed-price proof sequence shipped with the build.
          Compliant settlements pay {symbol} on Stellar testnet, while forged or replayed proofs are submitted and
          <strong> revert on-chain</strong> with real explorer links.
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
  if (scenario === "unsupportedAmount") return "Stopped before chain: this deployment ships a precomputed compliant sequence for the configured raw amount. Pick that amount for the compliant path, or exceed the limit to test witness rejection.";
  if (scenario === "sequenceUnavailable") return "Stopped before chain: the committed settlement sequence is not loaded, so the UI cannot select a proof input that extends the live root.";
  return "No proof can exist.";
}
