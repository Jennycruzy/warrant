#!/usr/bin/env bash
# Compile the additive address-bound WARRANT oracle circuit and run a demo
# Groth16 setup over BLS12-381. Existing id-based artifacts are not modified.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

B=app/build
CURVE=bls12381
POT_POWER=14
CIRCUIT=mandate_oracle_allow_addr
entropy() { head -c 64 /dev/urandom | base64 | tr -d '\n'; }
snarkjs() { node "$ROOT/node_modules/.bin/snarkjs" "$@"; }

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
mkdir -p "$B"

say "Compile additive circuit (circom -p $CURVE)"
circom "app/circuits/${CIRCUIT}.circom" --r1cs --wasm --sym -p "$CURVE" -l node_modules -o "$B"
for n in 2 3 4; do
  circom "app/circuits/poseidon${n}.circom" --wasm -p "$CURVE" -l node_modules -o "$B"
done

say "Powers of Tau ($CURVE, 2^$POT_POWER)"
if [ ! -f "$B/pot_final.ptau" ]; then
  snarkjs powersoftau new "$CURVE" "$POT_POWER" "$B/pot_0.ptau" -v
  snarkjs powersoftau contribute "$B/pot_0.ptau" "$B/pot_1.ptau" --name="warrant addr phase1" -v -e="$(entropy)"
  snarkjs powersoftau prepare phase2 "$B/pot_1.ptau" "$B/pot_final.ptau" -v
else
  echo "  reusing existing $B/pot_final.ptau"
fi

say "Groth16 setup -> zkey -> verification key"
snarkjs groth16 setup "$B/${CIRCUIT}.r1cs" "$B/pot_final.ptau" "$B/${CIRCUIT}_0.zkey"
snarkjs zkey contribute "$B/${CIRCUIT}_0.zkey" "$B/${CIRCUIT}_final.zkey" --name="warrant addr phase2" -v -e="$(entropy)"
snarkjs zkey export verificationkey "$B/${CIRCUIT}_final.zkey" "$B/${CIRCUIT}_vk.json"

say "Done"
ls -la "$B/${CIRCUIT}.r1cs" "$B/${CIRCUIT}_js/${CIRCUIT}.wasm" "$B/${CIRCUIT}_final.zkey" "$B/${CIRCUIT}_vk.json"
