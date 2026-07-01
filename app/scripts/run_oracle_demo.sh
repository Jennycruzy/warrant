#!/usr/bin/env bash
# Maintained live-Reflector oracle demo entrypoint.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec node app/scripts/sdk/drive_reflector.mjs "$@"
