#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"
export STELLAR_ACCOUNT="${STELLAR_ACCOUNT:-warrant-admin}"
export STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"

B=app/build
ENC="cargo run -q -p circom-to-soroban-hex --manifest-path app/Cargo.toml --"
WASM=app/target/wasm32v1-none/release/warrant.wasm
ZKEY=$B/mandate_oracle_allow_final.zkey
CWASM=$B/mandate_oracle_allow_js/mandate_oracle_allow.wasm
VK_HEX="$(tr -d '\r\n' < $B/mandate_oracle_allow_vk.hex)"
EXPLORER="https://stellar.expert/explorer/testnet/tx"

AMOUNT=50
RECIP=0
PRICE_OK=10
PRICE_BREACH=8
TIMESTAMP=1800000000

ADMIN="$(stellar keys address warrant-admin)"
TOKEN="$(cat $B/native_sac.txt)"
R0="$(grep -o 'G[A-Z0-9]\{55\}' $B/recipient0.txt)"

note() { echo; echo "==================== $* ===================="; }
fail() { echo "ORACLE DEMO FAILED: $*" >&2; exit 1; }
bal()  { stellar contract invoke --id "$TOKEN" --network "$STELLAR_NETWORK" -- balance --id "$1" 2>/dev/null | tr -d '"'; }
root() { stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- current_state_root 2>/dev/null | tr -d '"'; }

prove() {
  local book="$1" rcp="$2" amt="$3" price="$4" pfx="$5"
  node app/scripts/book_input_oracle_allow.js "$book" "$rcp" "$amt" "$price" "$pfx.input.json" >/dev/null
  node "$B/mandate_oracle_allow_js/generate_witness.js" "$CWASM" "$pfx.input.json" "$pfx.wtns" >/dev/null
  snarkjs groth16 prove "$ZKEY" "$pfx.wtns" "$pfx.proof.json" "$pfx.public.json" >/dev/null 2>&1
  $ENC proof "$pfx.proof.json" > "$pfx.proof.hex"
  $ENC public "$pfx.public.json" > "$pfx.public.hex"
  cat "$pfx.input.json.meta.json"
}

settle_with_price() {
  local p="$1" s="$2" price="$3" timestamp="$4" sig="$5"
  stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" --send=yes -- settle_with_price \
    --proof_bytes "$(tr -d '\r\n' < "$p")" \
    --pub_signals_bytes "$(tr -d '\r\n' < "$s")" \
    --price "$price" \
    --timestamp "$timestamp" \
    --signature "$sig" 2>&1
}

note "BUILD contract wasm with oracle entrypoint"
cargo build --manifest-path app/Cargo.toml --target wasm32v1-none --release -p warrant >/dev/null

note "RESET oracle private book"
cp app/scripts/oracle_book.json "$B/oracle_book.json"
cat "$B/oracle_book.json"

note "SIGN authenticated price report"
REPORT="$(node app/scripts/sign_price.js "$PRICE_OK" "$TIMESTAMP")"
ORACLE_PK="$(echo "$REPORT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).publicKeyHex)')"
SIG_OK="$(echo "$REPORT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).signatureHex)')"
MSG_HEX="$(echo "$REPORT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).messageHex)')"
echo "oracle_pubkey=$ORACLE_PK"
echo "signed_message=$MSG_HEX"

note "PROVE action under signed price=$PRICE_OK"
META="$(prove "$B/oracle_book.json" "$RECIP" "$AMOUNT" "$PRICE_OK" "$B/oracle_ok")"
COMMIT="$(echo "$META" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).commitmentHex)')"
GENROOT="$(echo "$META" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).prevRootHex)')"
ROOT1="$(echo "$META" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).nextRootHex)')"
echo "commitment=$COMMIT genesisRoot=$GENROOT root1=$ROOT1"

note "DEPLOY + INIT + SET_VK + SET_ORACLE + REGISTER + FUND"
CID="$(stellar contract deploy --wasm "$WASM" --network "$STELLAR_NETWORK" 2>/dev/null | grep -Eo 'C[A-Z0-9]{55}' | tail -1)"
[ -n "$CID" ] || fail "deploy produced no contract id"
echo "contract=$CID"
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- init --admin "$ADMIN" --token "$TOKEN" --policy_commitment "$COMMIT" --initial_state_root "$GENROOT" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- set_vk --vk_bytes "$VK_HEX" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- set_oracle --public_key "$ORACLE_PK" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- register_recipient --id "$RECIP" --addr "$R0" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- fund --from "$ADMIN" --amount 1000 >/dev/null
[ "$(root)" = "$GENROOT" ] || fail "genesis root mismatch on-chain"

note "SETTLE with authenticated price — expect success"
C0="$(bal "$CID")"; R0BAL0="$(bal "$R0")"
OUT="$(settle_with_price "$B/oracle_ok.proof.hex" "$B/oracle_ok.public.hex" "$PRICE_OK" "$TIMESTAMP" "$SIG_OK")"
echo "$OUT" | grep -Eo "$EXPLORER/[a-f0-9]+" | head -1
C1="$(bal "$CID")"; R0BAL1="$(bal "$R0")"
[ "$((C0 - C1))" -eq "$AMOUNT" ] || fail "contract delta $((C0-C1)) != $AMOUNT"
[ "$((R0BAL1 - R0BAL0))" -eq "$AMOUNT" ] || fail "recipient delta != $AMOUNT"
[ "$(root)" = "$ROOT1" ] || fail "root did not advance"
echo "OK: signed price report verified, funds moved, root advanced"

note "RE-MARK at price=$PRICE_BREACH — expect NO witness/proof"
rm -f "$B/oracle_breach.wtns"
node app/scripts/book_input_oracle_allow.js "$B/oracle_book.json" "$RECIP" "$AMOUNT" "$PRICE_BREACH" "$B/oracle_breach.input.json" >/dev/null
if node "$B/mandate_oracle_allow_js/generate_witness.js" "$CWASM" "$B/oracle_breach.input.json" "$B/oracle_breach.wtns" >/dev/null 2>&1; then
  fail "breached oracle mark produced a witness"
fi
[ ! -f "$B/oracle_breach.wtns" ] || fail "breached oracle witness file exists"
echo "OK: lower signed mark makes the same action unprovable"

note "SUMMARY"
echo "contract:        $CID"
echo "token (SAC):     $TOKEN"
echo "oracle pubkey:   $ORACLE_PK"
echo "signed report:   price=$PRICE_OK timestamp=$TIMESTAMP message=$MSG_HEX"
echo "state root chain: genesis=$GENROOT -> root1=$ROOT1 (current on-chain: $(root))"
echo "recipient credited: $(( $(bal "$R0") - R0BAL0 )) stroops (expected $AMOUNT)"
echo "ALL ORACLE CHECKS PASSED"
