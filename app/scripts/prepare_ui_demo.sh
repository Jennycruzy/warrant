#!/usr/bin/env bash
# Re-provision the wallet UI demo using the maintained SDK path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec node app/scripts/sdk/setup_demo.mjs app/frontend/public/demo-config.json .keys.json "$@"
