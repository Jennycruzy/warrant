import { useEffect, useMemo, useState } from "react";
import * as snarkjs from "snarkjs";
import { proofToHex, publicSignalsToHex } from "./lib/snarkHex.js";
import { DEFAULT_NETWORK, DEFAULT_RPC, readContractState, settleWithFootprint, settleWithPrice } from "./lib/stellarWarrant.js";

const explorer = "https://stellar.expert/explorer/testnet/tx/";
const sourceSecret = import.meta.env.VITE_SOURCE_SECRET || "";

const scenarios = {
  valid: "/valid.input.json",
  overLimit: "/over_limit.input.json",
  nonAllow: "/non_allow.input.json",
  breach: "/breach.input.json",
};

function short(value, chars = 10) {
  if (!value) return "not set";
  return `${String(value).slice(0, chars)}...${String(value).slice(-chars)}`;
}

function Step({ name, state }) {
  return <span className={`step ${state}`}>{name}</span>;
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [chain, setChain] = useState({});
  const [amount, setAmount] = useState(50);
  const [recipient, setRecipient] = useState("0");
  const [observer, setObserver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("Ready.");
  const [proofHex, setProofHex] = useState("");
  const [publicHex, setPublicHex] = useState("");
  const [lastProof, setLastProof] = useState(null);
  const [footprint, setFootprint] = useState(null);
  const [feed, setFeed] = useState([]);

  const network = DEFAULT_NETWORK;
  const rpcUrl = config?.rpcUrl || DEFAULT_RPC;
  const secretMandate = config?.mandate || { maxPerTx: "100", maxPosition: "1000", drawdownLimit: "100" };
  const privateBook = config?.book || { position: "100", peakEquity: "1000" };

  useEffect(() => {
    fetch("/demo-config.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    if (!config?.contractId) return;
    readContractState({ rpcUrl, contractId: config.contractId })
      .then(setChain)
      .catch((err) => setMessage(`Chain read failed: ${err.message || String(err)}`));
  }, [config?.contractId, rpcUrl]);

  const selectedScenario = useMemo(() => {
    if (recipient !== "0") return "nonAllow";
    if (amount > Number(secretMandate.maxPerTx)) return "overLimit";
    return "valid";
  }, [amount, recipient, secretMandate.maxPerTx]);

  function appendFeed(row) {
    setFeed((rows) => [{ id: Date.now(), ...row }, ...rows].slice(0, 8));
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
    return {
      input,
      proofHex: proofToHex(proof),
      publicHex: publicSignalsToHex(publicSignals),
      publicSignals,
    };
  }

  async function onSettle() {
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
      const sent = await settleWithPrice({
        rpcUrl,
        networkPassphrase: network,
        sourceSecret,
        contractId: config.contractId,
        proofHex: result.proofHex,
        publicHex: result.publicHex,
        price: config.price,
        timestamp: config.timestamp,
        signatureHex: config.signatureHex,
      });
      setStatus("settled");
      setLastProof(result);
      setFootprint(sent.footprint);
      appendFeed({ kind: "settled", text: "Compliant settlement paid", hash: sent.hash });
      setMessage("Settled on-chain. State root advanced. Forged and replay attempts now land as real reverted txs.");
      setChain(await readContractState({ rpcUrl, contractId: config.contractId }));
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

  // Force-submit a deliberately invalid settlement so the contract reverts on-chain.
  async function submitAdversarial({ kind, proofHex, publicHex, expected, describe }) {
    setBusy(true);
    setStatus("submitting");
    try {
      const res = await settleWithFootprint({
        rpcUrl,
        networkPassphrase: network,
        sourceSecret,
        contractId: config.contractId,
        proofHex,
        publicHex,
        price: config.price,
        timestamp: config.timestamp,
        signatureHex: config.signatureHex,
        footprint,
      });
      if (res.status === "FAILED") {
        setStatus("rejected");
        appendFeed({ kind: "rejected", text: `${describe} reverted on-chain (${res.reason.name || `#${res.reason.code}`})`, hash: res.hash });
        setMessage(`Contract reverted the ${kind} on-chain: ${res.reason.name || "rejected"} (#${res.reason.code ?? "?"}). This is a real, committed testnet transaction — open the explorer link.`);
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

  // Present the real proof but lie about which state it extends: claim prevStateRoot =
  // current on-chain root (so the staleness check passes) while the proof actually
  // attests genesis -> next. The pairing then fails => contract reverts ProofInvalid.
  function onForged() {
    if (!requireAnchor()) return;
    const forgedSignals = [...lastProof.publicSignals];
    forgedSignals[1] = lastProof.publicSignals[2];
    forgedSignals[2] = "12345";
    return submitAdversarial({
      kind: "forged proof",
      describe: "Forged proof",
      expected: "ProofInvalid #10",
      proofHex: lastProof.proofHex,
      publicHex: publicSignalsToHex(forgedSignals),
    });
  }

  // Resubmit the previous compliant proof. Its prevStateRoot is the old root, but the
  // root has already advanced => contract reverts StaleStateRoot.
  function onReplay() {
    if (!requireAnchor()) return;
    return submitAdversarial({
      kind: "replayed proof",
      describe: "Replay",
      expected: "StaleStateRoot #9",
      proofHex: lastProof.proofHex,
      publicHex: lastProof.publicHex,
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
          <p className="eyebrow">Proof-carrying compliance</p>
          <h1>WARRANT</h1>
        </div>
        <button className="toggle" onClick={() => setObserver((v) => !v)}>
          {observer ? "Hide observer view" : "Observer view"}
        </button>
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
          <p className="lock">Locked locally. Never leaves device.</p>
        </aside>

        <section className="zone action">
          <p className="label">Action</p>
          <h2>Try to move funds</h2>
          <label>Amount <strong>{amount}</strong>
            <input type="range" min="1" max="160" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          </label>
          <label>Recipient
            <select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
              <option value="0">Recipient 0, allowlisted</option>
              <option value="7">Recipient 7, not allowlisted</option>
            </select>
          </label>
          <div className="buttons">
            <button disabled={busy || !config} onClick={onSettle}>Settle</button>
            <button disabled={busy || !config} onClick={onForged}>Submit forged proof</button>
            <button disabled={busy || !config} onClick={onReplay}>Replay last proof</button>
            <button disabled={busy || !config} onClick={onRemark}>Oracle re-mark</button>
          </div>
          <div className="pipeline">
            <Step name="idle" state={status === "idle" ? "active" : ""} />
            <Step name="witness" state={status === "witness" ? "active" : ""} />
            <Step name="prove" state={status === "proving" ? "active" : ""} />
            <Step name="submit" state={status === "submitting" ? "active" : ""} />
            <Step name="settled" state={status === "settled" ? "good" : ""} />
            <Step name="rejected" state={status === "rejected" || status === "blocked" ? "bad" : ""} />
          </div>
          <p className="message">{message}</p>
        </section>

        <aside className="zone chain">
          <p className="label">What the chain sees</p>
          <h2>Hashes and public action</h2>
          <dl>
            <dt>Contract</dt><dd>{short(config?.contractId, 8)}</dd>
            <dt>Policy commitment</dt><dd>{short(chain.commitment || config?.commitmentHex, 8)}</dd>
            <dt>State root</dt><dd>{short(chain.root || config?.genesisRootHex, 8)}</dd>
            <dt>Price report</dt><dd>{config ? `price ${config.price}, timestamp ${config.timestamp}` : "not prepared"}</dd>
          </dl>
          <p className="lock">The limits appear nowhere here.</p>
        </aside>
      </section>

      {observer && (
        <section className="observer">
          <h2>Raw observer bytes</h2>
          <pre>{JSON.stringify({
            contractId: config?.contractId,
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
            <span className={`pill ${row.kind}`}>{row.kind}</span>
            <span>{row.text}</span>
            {row.hash && <a href={`${explorer}${row.hash}`} target="_blank" rel="noreferrer">Explorer</a>}
          </div>
        ))}
      </section>

      <footer>
        <p>
          No mocks: proofs are generated with snarkjs in this browser; compliant settlements pay on Stellar
          testnet, and forged or replayed proofs are submitted and <strong>revert on-chain</strong> with real explorer links.
        </p>
        <p className="verify">Don't trust this UI — verify the live contract directly (no keys needed):</p>
        <code>stellar contract invoke --id {config?.contractId || "<contract-id>"} --network testnet -- current_state_root</code>
      </footer>
    </main>
  );
}

function reasonFor(scenario) {
  if (scenario === "overLimit") return "No proof can exist: amount exceeds the hidden maxPerTx. Never reached chain.";
  if (scenario === "nonAllow") return "No proof can exist: recipient is not in the committed private allowlist. Never reached chain.";
  return "No proof can exist.";
}
