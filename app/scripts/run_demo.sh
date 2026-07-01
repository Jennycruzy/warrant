#!/usr/bin/env bash
# Maintained end-to-end demo entrypoint.
#
# The legacy Stellar-CLI flow depended on excluded bring-up artifacts. The SDK
# driver provisions a fresh testnet deployment from committed artifacts, submits
# chained compliant settlements, then force-submits forged/replay attempts that
# land as real reverted transactions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec node app/scripts/sdk/drive.mjs "$@"
