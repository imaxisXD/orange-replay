#!/usr/bin/env python3
"""Deprecated: use purge_pending.py so D1 leases and verification cannot be skipped."""

import sys


print(
    "purge_session.py is disabled; use infra/analytics/purge_pending.py through the scheduled runner",
    file=sys.stderr,
)
sys.exit(2)
