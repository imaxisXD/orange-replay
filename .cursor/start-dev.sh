#!/usr/bin/env bash
set -euo pipefail

cd /workspace
exec pnpm exec vp run dev
