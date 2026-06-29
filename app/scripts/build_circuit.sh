#!/usr/bin/env bash
# Compile the WARRANT circuits and run the Groth16 setup over BLS12-381, then
# ship the proving artifacts the contract VK and the browser prover depend on.
#
# Produces (all regenerable, all git-ignored under app/build):
#   app/build/mandate_oracle_allow.r1cs / _js/*.wasm / _final.zkey / _vk.json
#   app/build/poseidon{2,3,4}_js/*.wasm   (field-correct off-chain Poseidon)
# and copies the two browser/prover artifacts into the frontend:
#   app/frontend/public/circuits/mandate_oracle_allow.wasm
#   app/frontend/public/proving/mandate_oracle_allow_final.zkey
#
# This is a DEMO trusted setup (single contributor with fresh entropy), not a
# production MPC ceremony — same honest caveat as the README.
#
# Usage:  bash app/scripts/build_circuit.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

B=app/build
PUB=app/frontend/public
CURVE=bls12381
POT_POWER=14            # 2^14 = 16384 >= ~4170 constraints
CIRCUIT=mandate_oracle_allow
entropy() { head -c 64 /dev/urandom | base64 | tr -d '\n'; }
snarkjs() { node "$ROOT/node_modules/.bin/snarkjs" "$@"; }   # local dep, no global bin

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
mkdir -p "$B" "$PUB/circuits" "$PUB/proving"

say "Compile circuits (circom -p $CURVE)"
circom "app/circuits/${CIRCUIT}.circom" --r1cs --wasm --sym -p "$CURVE" -l node_modules -o "$B"
for n in 2 3 4; do
  circom "app/circuits/poseidon${n}.circom" --wasm -p "$CURVE" -l node_modules -o "$B"
done

say "Powers of Tau ($CURVE, 2^$POT_POWER)"
if [ ! -f "$B/pot_final.ptau" ]; then
  snarkjs powersoftau new "$CURVE" "$POT_POWER" "$B/pot_0.ptau" -v
  snarkjs powersoftau contribute "$B/pot_0.ptau" "$B/pot_1.ptau" --name="warrant phase1" -v -e="$(entropy)"
  snarkjs powersoftau prepare phase2 "$B/pot_1.ptau" "$B/pot_final.ptau" -v
else
  echo "  reusing existing $B/pot_final.ptau"
fi

say "Groth16 setup -> zkey -> verification key"
snarkjs groth16 setup "$B/${CIRCUIT}.r1cs" "$B/pot_final.ptau" "$B/${CIRCUIT}_0.zkey"
snarkjs zkey contribute "$B/${CIRCUIT}_0.zkey" "$B/${CIRCUIT}_final.zkey" --name="warrant phase2" -v -e="$(entropy)"
snarkjs zkey export verificationkey "$B/${CIRCUIT}_final.zkey" "$B/${CIRCUIT}_vk.json"

say "Ship artifacts to the frontend"
cp "$B/${CIRCUIT}_js/${CIRCUIT}.wasm" "$PUB/circuits/${CIRCUIT}.wasm"
cp "$B/${CIRCUIT}_final.zkey"          "$PUB/proving/${CIRCUIT}_final.zkey"

say "Done"
ls -la "$PUB/circuits/${CIRCUIT}.wasm" "$PUB/proving/${CIRCUIT}_final.zkey"
echo "verification key: $B/${CIRCUIT}_vk.json"
