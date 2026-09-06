#!/usr/bin/env bash
# Shared PATH setup for Cloud Agent shells (login and non-login).
set -euo pipefail

export PATH="/workspace/node_modules/.bin:${PATH:-}"

if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use 22.22.2 2>/dev/null || nvm use 22 2>/dev/null || true
  for candidate in v22.22.2 v22.18.0; do
    NVM_BIN_DIR="$NVM_DIR/versions/node/$candidate/bin"
    if [ -x "$NVM_BIN_DIR/node" ]; then
      export PATH="$NVM_BIN_DIR:$PATH"
      break
    fi
  done
elif [ -x /usr/local/bin/node ]; then
  export PATH="/usr/local/bin:$PATH"
fi
