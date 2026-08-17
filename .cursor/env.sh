#!/usr/bin/env bash
# Shared PATH setup for Cloud Agent shells (login and non-login).
set -euo pipefail

export PATH="/workspace/node_modules/.bin:${PATH:-}"

if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use 22.22.2 2>/dev/null || nvm use 22 2>/dev/null || true
  NVM_NODE="$(nvm which current 2>/dev/null || nvm which node 2>/dev/null || true)"
  if [ -n "$NVM_NODE" ] && [ -x "$NVM_NODE" ]; then
    export PATH="$(dirname "$NVM_NODE"):$PATH"
  fi
elif [ -x /usr/local/bin/node ]; then
  export PATH="/usr/local/bin:$PATH"
fi
