# Accepted usage accounting

Replay bytes used to reach `usage_monthly` only after a session finalized. A
session that stayed open or repeatedly failed finalization could therefore use
storage without appearing in usage totals.

## How it works

`accepted_usage_sessions` is a short-lived, one-row-per-session D1 ledger. Its
byte value only moves upward. The recorder reserves the current accepted byte
total before an append returns success. A duplicate append repeats the same
target, so it repairs a failed earlier reservation without charging twice.

The ledger delta and `usage_monthly.bytes` update run in one D1 batch. The first
reservation writes the ledger row and the monthly delta. A later increase
writes one monthly row and one ledger row. A duplicate target performs no D1
row writes. The batch also verifies the stored session identity and total before
the recorder acknowledges the append.

The finalizer reserves the larger of the replay object bytes and the accepted
payload plus metadata bytes before it writes the manifest or sends the existing
finalize queue message. The queue contract did not change.

The compatible consumer handles both producer versions:

- An old producer has no ledger row. The consumer reserves `message.bytes` as a
  fallback, indexes the session, and increments the monthly session count.
- A new producer already reserved its full byte total. The fallback is a
  no-op, so the consumer increments only the session count.
- After indexing, or after a deletion fence blocks indexing, the same D1
  transaction deletes the short-lived ledger row. A later append reservation
  sees the final session row and fails closed.

## Cost and latency

Every accepted non-duplicate append adds one D1 batch on the response path. It
contains four write statements plus one verification read:

- First reservation: two row writes.
- Higher target: two row writes.
- Exact duplicate or finalize retry: zero row writes.
- Segment flush: another reservation only writes when the encoded R2 bytes are
  larger than the already reserved target.
- Finalization: no new queue message. The existing consumer transaction adds
  one ledger delete; the existing monthly update now changes only the session
  count.

This adds a D1 network round trip to append latency. It is deliberate: a D1
failure must not return a successful ingest acknowledgement. The Durable Object
stores the batch first, then attempts the D1 reservation and recovery alarm
together. If D1 fails, the alarm or a duplicate client retry repairs the same
monotonic target. If the alarm call fails, the D1 reservation can still succeed.
If both services fail, the client receives an error and its duplicate retry
repairs both operations.

## Production rollout

Do not enable recorder-side reservations in the first deployment. An old queue
consumer would add replay bytes again after the new recorder had already added
them.

1. Apply D1 migration `0022_accepted_usage_reservations.sql` to every shard.
2. Deploy the Worker with `ACCEPTED_USAGE_RESERVATIONS=0`. This installs the
   compatible consumer while producers keep the old behavior.
3. Confirm the old Worker version is no longer consuming finalize jobs.
4. Change `ACCEPTED_USAGE_RESERVATIONS` to `1` and deploy again.

Rollback is safe: set the flag back to `0`. The compatible consumer continues
to account for old producer messages. Fresh self-host installs apply all
migrations before their first deploy and therefore enable the flag immediately.

No historical backfill is required. Existing finalized usage stays unchanged.
An active session created before the flag is enabled gets its ledger on its next
append, alarm, or finalization attempt.
