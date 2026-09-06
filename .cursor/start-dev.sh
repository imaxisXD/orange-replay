#!/usr/bin/env bash
set -euo pipefail

cd /workspace
# shellcheck source=/dev/null
source ./.cursor/env.sh

exec pnpm exec vp run dev
