#!/usr/bin/env bash
# WARRANT end-to-end demo on Stellar testnet.
#
# Deterministic and idempotent: every run resets the prover's private book to
# genesis, deploys a fresh custody contract, and drives the full sequence:
#   deploy -> init -> fund -> compliant settle #1 -> compliant settle #2
#   -> violating action -> forged proof -> replayed proof.
#
# It FAILS CLOSED: any step whose real on-chain result does not match the
# expected outcome aborts the script with a non-zero exit.
#
# Prerequisites (produced by the circuit setup / contract build):
#   app/build/mandate_js/mandate.wasm, app/build/mandate_final.zkey,
#   app/build/mandate_vk.hex, app/target/wasm32v1-none/release/warrant.wasm
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"
export STELLAR_ACCOUNT="${STELLAR_ACCOUNT:-warrant-admin}"
export STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"

B=app/build
ENC=CircomStellar/target/debug/circom-to-soroban-hex
WASM=app/target/wasm32v1-none/release/warrant.wasm
ZKEY=$B/mandate_final.zkey
CWASM=$B/mandate_js/mandate.wasm
VK_HEX="$(tr -d '\r\n' < $B/mandate_vk.hex)"
EXPLORER="https://stellar.expert/explorer/testnet/tx"

AMOUNT1=500000000   # 50 XLM
AMOUNT2=300000000   # 30 XLM
RECIP=0

ADMIN="$(stellar keys address warrant-admin)"
TOKEN="$(cat $B/native_sac.txt)"
R0="$(grep -o 'G[A-Z0-9]\{55\}' $B/recipient0.txt)"

note() { echo; echo "==================== $* ===================="; }
fail() { echo "DEMO FAILED: $*" >&2; exit 1; }
bal()  { stellar contract invoke --id "$TOKEN" --network "$STELLAR_NETWORK" -- balance --id "$1" 2>/dev/null | tr -d '"'; }
root() { stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- current_state_root 2>/dev/null | tr -d '"'; }
hex2dec() { node -e 'process.stdout.write(BigInt("0x"+process.argv[1]).toString())' "$1"; }

# prove <bookFile> <amount> <recip> <prefix> : write <prefix>_proof.hex/_public.hex, echo meta json
prove() {
  local book="$1" amt="$2" rcp="$3" pfx="$4"
  node app/scripts/book_input.js "$book" "$amt" "$rcp" "$pfx.input.json" >/dev/null
  node "$B/mandate_js/generate_witness.js" "$CWASM" "$pfx.input.json" "$pfx.wtns" >/dev/null
  snarkjs groth16 prove "$ZKEY" "$pfx.wtns" "$pfx.proof.json" "$pfx.public.json" >/dev/null 2>&1
  $ENC proof  "$pfx.proof.json"  > "$pfx.proof.hex"
  $ENC public "$pfx.public.json" > "$pfx.public.hex"
  cat "$pfx.input.json.meta.json"
}

settle() { # settle <proof.hex> <public.hex> ; echoes tx url, aborts on contract error
  local p="$1" s="$2"
  stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" --send=yes -- settle \
    --proof_bytes "$(tr -d '\r\n' < "$p")" --pub_signals_bytes "$(tr -d '\r\n' < "$s")" 2>&1
}

note "RESET prover private book to genesis"
cp app/scripts/genesis_book.json "$B/book.json"
cat "$B/book.json"

note "PROVE compliant settle #1 (amount=$AMOUNT1) from genesis book"
META1="$(prove "$B/book.json" "$AMOUNT1" "$RECIP" "$B/d1")"
COMMIT="$(echo "$META1" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).commitmentHex)')"
GENROOT="$(echo "$META1" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).prevRootHex)')"
ROOT1="$(echo "$META1" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).nextRootHex)')"
echo "commitment=$COMMIT genesisRoot=$GENROOT root1=$ROOT1"

note "DEPLOY + INIT + SET_VK + REGISTER + FUND"
CID="$(stellar contract deploy --wasm "$WASM" --network "$STELLAR_NETWORK" 2>/dev/null | grep -Eo 'C[A-Z0-9]{55}' | tail -1)"
[ -n "$CID" ] || fail "deploy produced no contract id"
echo "contract=$CID"
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- init --admin "$ADMIN" --token "$TOKEN" --policy_commitment "$COMMIT" --initial_state_root "$GENROOT" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- set_vk --vk_bytes "$VK_HEX" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- register_recipient --id "$RECIP" --addr "$R0" >/dev/null
stellar contract invoke --id "$CID" --network "$STELLAR_NETWORK" -- fund --from "$ADMIN" --amount 1000000000 >/dev/null
[ "$(root)" = "$GENROOT" ] || fail "genesis root mismatch on-chain"
echo "funded; on-chain root = genesis ($GENROOT)"

note "SETTLE #1 (compliant) — expect success, +$AMOUNT1 to recipient, root -> root1"
C0="$(bal "$CID")"; R0BAL0="$(bal "$R0")"
OUT="$(settle "$B/d1.proof.hex" "$B/d1.public.hex")"
echo "$OUT" | grep -Eo "$EXPLORER/[a-f0-9]+" | head -1
C1="$(bal "$CID")"; R0BAL1="$(bal "$R0")"
[ "$((C0 - C1))" -eq "$AMOUNT1" ]      || fail "settle1 contract delta $((C0-C1)) != $AMOUNT1"
[ "$((R0BAL1 - R0BAL0))" -eq "$AMOUNT1" ] || fail "settle1 recipient delta != $AMOUNT1"
[ "$(root)" = "$ROOT1" ]               || fail "settle1 root did not advance to root1"
node app/scripts/advance_book.js "$B/book.json" "$AMOUNT1"
echo "OK: settle1 moved $AMOUNT1, root advanced genesis->root1"

note "PROVE compliant settle #2 (amount=$AMOUNT2) from UPDATED book"
META2="$(prove "$B/book.json" "$AMOUNT2" "$RECIP" "$B/d2")"
PREV2="$(echo "$META2" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).prevRootHex)')"
ROOT2="$(echo "$META2" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).nextRootHex)')"
[ "$PREV2" = "$ROOT1" ] || fail "settle2 prevRoot ($PREV2) != current on-chain root1 ($ROOT1) — book not persisted"
echo "settle2 chains prevRoot=root1 -> root2=$ROOT2"

note "SETTLE #2 (compliant) — expect success, +$AMOUNT2, root1 -> root2"
C2a="$(bal "$CID")"; R0a="$(bal "$R0")"
OUT="$(settle "$B/d2.proof.hex" "$B/d2.public.hex")"
echo "$OUT" | grep -Eo "$EXPLORER/[a-f0-9]+" | head -1
C2b="$(bal "$CID")"; R0b="$(bal "$R0")"
[ "$((C2a - C2b))" -eq "$AMOUNT2" ] || fail "settle2 contract delta != $AMOUNT2"
[ "$((R0b - R0a))" -eq "$AMOUNT2" ] || fail "settle2 recipient delta != $AMOUNT2"
[ "$(root)" = "$ROOT2" ]            || fail "settle2 root did not advance to root2"
node app/scripts/advance_book.js "$B/book.json" "$AMOUNT2"
echo "OK: settle2 moved $AMOUNT2, root chained root1->root2"

note "VIOLATING action — amount 2000000000 > maxPerTx — expect NO witness/proof"
rm -f "$B/dviol.wtns"
node app/scripts/book_input.js "$B/book.json" 2000000000 "$RECIP" "$B/dviol.input.json" >/dev/null
if node "$B/mandate_js/generate_witness.js" "$CWASM" "$B/dviol.input.json" "$B/dviol.wtns" >/dev/null 2>&1; then
  fail "violating witness was produced — circuit did not enforce the limit"
fi
[ ! -f "$B/dviol.wtns" ] || fail "violating witness file exists"
echo "OK: witness generation rejected the over-limit amount; no proof can exist"

note "FORGED proof — well-formed proof bytes that do NOT prove this statement — expect revert"
C3a="$(bal "$CID")"
ROOT2_DEC="$(hex2dec "$ROOT2")"
printf '["%s","%s","%s","500000000","0"]' "$(hex2dec "$COMMIT")" "$ROOT2_DEC" "$(hex2dec "$COMMIT")" > "$B/forged.public.json"
$ENC public "$B/forged.public.json" > "$B/forged.public.hex"
set +e
OUTF="$(settle "$B/d1.proof.hex" "$B/forged.public.hex")"; set -e
echo "$OUTF" | grep -qiE 'Error\(Contract, #10\)|ProofInvalid' || fail "forged proof was NOT rejected as ProofInvalid: $OUTF"
[ "$(bal "$CID")" -eq "$C3a" ] || fail "forged attempt moved funds"
echo "OK: forged proof reverted (ProofInvalid, #10); no movement"

note "REPLAY — resubmit settle #1 proof against the advanced root — expect revert"
C4a="$(bal "$CID")"
set +e
OUTR="$(settle "$B/d1.proof.hex" "$B/d1.public.hex")"; set -e
echo "$OUTR" | grep -qiE 'Error\(Contract, #9\)|StaleStateRoot' || fail "replay was NOT rejected as StaleStateRoot: $OUTR"
[ "$(bal "$CID")" -eq "$C4a" ] || fail "replay moved funds"
echo "OK: replay reverted (StaleStateRoot, #9); no movement"

note "SUMMARY"
echo "contract:        $CID"
echo "token (SAC):     $TOKEN"
echo "state root chain: genesis=$GENROOT"
echo "                  -> root1=$ROOT1"
echo "                  -> root2=$ROOT2 (current on-chain: $(root))"
echo "recipient0 net credited this run: $(( $(bal "$R0") - R0BAL0 )) stroops (expected $((AMOUNT1 + AMOUNT2)))"
echo "ALL CHECKS PASSED"
