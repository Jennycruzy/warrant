#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"
export STELLAR_ACCOUNT="${STELLAR_ACCOUNT:-warrant-admin}"
export STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"

B=app/build
WASM=app/target/wasm32v1-none/release/warrant.wasm
VK_HEX="$(tr -d '\r\n' < $B/mandate_oracle_allow_vk.hex)"
PRICE=10
TIMESTAMP=1800000000
AMOUNT=50
RECIP=0

ADMIN="$(stellar keys address warrant-admin)"
TOKEN="$(cat $B/native_sac.txt)"
R0="$(grep -o 'G[A-Z0-9]\{55\}' $B/recipient0.txt)"

note() { echo; echo "==================== $* ===================="; }
fail() { echo "UI PREP FAILED: $*" >&2; exit 1; }
root() { stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- current_state_root 2>/dev/null | tr -d '"'; }

note "BUILD final warrant contract"
cargo build --manifest-path app/Cargo.toml --target wasm32v1-none --release -p warrant >/dev/null

note "DERIVE UI scenario inputs"
node app/scripts/book_input_oracle_allow.js app/scripts/oracle_book.json "$RECIP" "$AMOUNT" "$PRICE" app/frontend/public/valid.input.json >/dev/null
node app/scripts/book_input_oracle_allow.js app/scripts/oracle_book.json "$RECIP" 150 "$PRICE" app/frontend/public/over_limit.input.json >/dev/null
node app/scripts/book_input_oracle_allow.js app/scripts/oracle_book.json 7 "$AMOUNT" "$PRICE" app/frontend/public/non_allow.input.json >/dev/null
node app/scripts/book_input_oracle_allow.js app/scripts/oracle_book.json "$RECIP" "$AMOUNT" 8 app/frontend/public/breach.input.json >/dev/null

META="$(cat app/frontend/public/valid.input.json.meta.json)"
COMMIT="$(echo "$META" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).commitmentHex)')"
GENROOT="$(echo "$META" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).prevRootHex)')"

note "SIGN oracle report"
REPORT="$(node app/scripts/sign_price.js "$PRICE" "$TIMESTAMP")"
ORACLE_PK="$(echo "$REPORT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).publicKeyHex)')"
SIG="$(echo "$REPORT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).signatureHex)')"
MSG="$(echo "$REPORT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).messageHex)')"

note "DEPLOY fresh UI contract"
CID="$(stellar contract deploy --wasm "$WASM" --network "$STELLAR_NETWORK" 2>/dev/null | grep -Eo 'C[A-Z0-9]{55}' | tail -1)"
[ -n "$CID" ] || fail "deploy produced no contract id"
echo "contract=$CID"
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- init --admin "$ADMIN" --token "$TOKEN" --policy_commitment "$COMMIT" --initial_state_root "$GENROOT" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- set_vk --vk_bytes "$VK_HEX" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- set_oracle --public_key "$ORACLE_PK" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- register_recipient --id "$RECIP" --addr "$R0" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- fund --from "$ADMIN" --amount 1000 >/dev/null
[ "$(root)" = "$GENROOT" ] || fail "genesis root mismatch"

note "WRITE frontend config"
node -e '
const fs = require("fs");
const [contractId, token, recipient, oraclePubKey, signatureHex, messageHex, commitmentHex, genesisRootHex] = process.argv.slice(1);
const cfg = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId,
  token,
  recipient,
  oraclePubKey,
  signatureHex,
  messageHex,
  commitmentHex,
  genesisRootHex,
  price: "10",
  timestamp: "1800000000",
  mandate: { maxPerTx: "100", maxPosition: "1000", drawdownLimit: "100" },
  book: { position: "100", peakEquity: "1000" }
};
fs.writeFileSync("app/frontend/public/demo-config.json", JSON.stringify(cfg, null, 2));
' "$CID" "$TOKEN" "$R0" "$ORACLE_PK" "$SIG" "$MSG" "$COMMIT" "$GENROOT"

echo "UI contract:      $CID"
echo "token:            $TOKEN"
echo "recipient:        $R0"
echo "oracle pubkey:    $ORACLE_PK"
echo "signed message:   $MSG"
echo "state root:       $(root)"
echo "Config written:   app/frontend/public/demo-config.json"
