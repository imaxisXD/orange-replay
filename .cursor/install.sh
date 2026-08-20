#!/usr/bin/env bash
set -euo pipefail

# Cloud Agent / local bootstrap: ensure the Vite+ CLI exists, then install
# this repo's dependencies from the lockfile. Idempotent.
export PATH="${HOME}/.vite-plus/bin:${PATH}"

if ! command -v vp >/dev/null 2>&1; then
  curl -fsSL https://vite.plus | bash
  export PATH="${HOME}/.vite-plus/bin:${PATH}"
fi

vp install
