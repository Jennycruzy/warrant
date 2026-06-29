#!/usr/bin/env bash
# WARRANT toolchain bootstrap — idempotent.
#
# Installs everything needed to compile the circom circuits, build the Soroban
# contract, and run the on-chain demo, pinned to the versions in README.md:
#   - Rust (stable) + the wasm32v1-none target
#   - circom 2.2.3
#   - Stellar CLI 27.0.0
#   - Node deps (snarkjs etc.) for the repo root and the frontend
#
# Safe to run repeatedly: each step is skipped when the right version is already
# present. Binaries land in ~/.local/bin (already on PATH for the demo scripts).
#
# Usage:  bash app/scripts/setup_toolchain.sh
#         npm run setup:toolchain
set -euo pipefail

CIRCOM_VERSION="2.2.3"
STELLAR_VERSION="27.0.0"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
# First line of a command's output without a pipe (avoids SIGPIPE on `| head`).
stellar_ver() { local v; v="$(stellar version 2>/dev/null)"; printf '%s\n' "${v%%$'\n'*}"; }

case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64; CIRCOM_ASSET=circom-linux-amd64 ;;
  aarch64|arm64) ARCH=aarch64; CIRCOM_ASSET=circom-linux-arm64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac

# ---------------------------------------------------------------------------
say "Rust toolchain"
if ! command -v cargo >/dev/null 2>&1; then
  warn "installing Rust (stable, minimal)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"
ok "$(rustc --version)"

if rustup target list --installed | grep -q '^wasm32v1-none$'; then
  ok "wasm32v1-none target present"
else
  warn "adding wasm32v1-none target"
  rustup target add wasm32v1-none
  ok "wasm32v1-none target added"
fi

# ---------------------------------------------------------------------------
say "circom $CIRCOM_VERSION"
if command -v circom >/dev/null 2>&1 && circom --version 2>/dev/null | grep -q "$CIRCOM_VERSION"; then
  ok "circom $CIRCOM_VERSION present"
else
  url="https://github.com/iden3/circom/releases/download/v${CIRCOM_VERSION}/${CIRCOM_ASSET}"
  warn "downloading $url"
  if curl -fsSL "$url" -o "$BIN_DIR/circom"; then
    chmod +x "$BIN_DIR/circom"
    ok "circom installed to $BIN_DIR/circom"
  else
    warn "prebuilt binary unavailable for this platform — building from source"
    tmp="$(mktemp -d)"
    git clone --depth 1 --branch "v${CIRCOM_VERSION}" https://github.com/iden3/circom.git "$tmp/circom"
    ( cd "$tmp/circom" && cargo build --release )
    install -m 0755 "$tmp/circom/target/release/circom" "$BIN_DIR/circom"
    rm -rf "$tmp"
    ok "circom built and installed"
  fi
fi
export PATH="$BIN_DIR:$PATH"
circom --version

# ---------------------------------------------------------------------------
say "Stellar CLI $STELLAR_VERSION"
if command -v stellar >/dev/null 2>&1 && stellar_ver | grep -q "$STELLAR_VERSION"; then
  ok "stellar $STELLAR_VERSION present"
else
  asset="stellar-cli-${STELLAR_VERSION}-${ARCH}-unknown-linux-gnu.tar.gz"
  url="https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_VERSION}/${asset}"
  warn "downloading $url"
  tmp="$(mktemp -d)"
  if curl -fsSL "$url" -o "$tmp/stellar.tar.gz"; then
    tar -xzf "$tmp/stellar.tar.gz" -C "$tmp"
    install -m 0755 "$tmp/stellar" "$BIN_DIR/stellar"
    ok "stellar installed to $BIN_DIR/stellar"
  else
    warn "prebuilt release unavailable — installing via cargo (slow)"
    cargo install --locked stellar-cli --version "$STELLAR_VERSION"
  fi
  rm -rf "$tmp"
fi
stellar_ver

# ---------------------------------------------------------------------------
say "Node dependencies"
if [ -d node_modules ]; then ok "root node_modules present"; else warn "npm install (root)"; npm install; fi
if [ -d app/frontend/node_modules ]; then ok "frontend node_modules present"; else warn "npm install (frontend)"; ( cd app/frontend && npm install ); fi

# ---------------------------------------------------------------------------
say "Done"
cat <<EOF
  rust    : $(rustc --version)
  wasm    : wasm32v1-none
  circom  : $(circom --version)
  stellar : $(stellar_ver)
  snarkjs : $(node -e "console.log(require('snarkjs/package.json').version)" 2>/dev/null || echo "see node_modules")

Binaries are in $BIN_DIR. If 'circom'/'stellar' are not found in a new shell, add:
  export PATH="\$HOME/.local/bin:\$HOME/.cargo/bin:\$PATH"
EOF
