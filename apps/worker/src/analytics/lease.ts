export const ANALYTICS_LEASE_DURATION_MS = 2 * 60 * 1_000;

interface LeaseOwnerRow {
  owner_id: string;
}

interface SendWindowRow {
  send_available_at: number;
}

export async function tryAcquireAnalyticsLease(
  db: D1Database,
  ownerId: string,
  now = Date.now(),
  durationMs = ANALYTICS_LEASE_DURATION_MS,
): Promise<boolean> {
  const lease = checkedLease(ownerId, now, durationMs);
  const row = await db
    .prepare(
      `INSERT INTO analytics_export_lease
        (shard, owner_id, acquired_at, expires_at, send_available_at)
      VALUES (0, ?, ?, ?, 0)
      ON CONFLICT(shard) DO UPDATE SET
        owner_id = excluded.owner_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
      WHERE (
          analytics_export_lease.expires_at <= ?
          AND analytics_export_lease.send_available_at <= ?
        )
        OR analytics_export_lease.owner_id = excluded.owner_id
      RETURNING owner_id`,
    )
    .bind(lease.ownerId, lease.now, lease.expiresAt, lease.now, lease.now)
    .first<LeaseOwnerRow>();
  return row?.owner_id === lease.ownerId;
}

export async function renewAnalyticsLease(
  db: D1Database,
  ownerId: string,
  now = Date.now(),
  durationMs = ANALYTICS_LEASE_DURATION_MS,
): Promise<boolean> {
  const lease = checkedLease(ownerId, now, durationMs);
  const row = await db
    .prepare(
      `UPDATE analytics_export_lease
      SET expires_at = ?
      WHERE shard = 0 AND owner_id = ? AND expires_at > ?
      RETURNING owner_id`,
    )
    .bind(lease.expiresAt, lease.ownerId, lease.now)
    .first<LeaseOwnerRow>();
  return row?.owner_id === lease.ownerId;
}

export async function reserveAnalyticsSendWindow(
  db: D1Database,
  ownerId: string,
  requestBytes: number,
  bytesPerSecond: number,
  now = Date.now(),
  leaseDurationMs = ANALYTICS_LEASE_DURATION_MS,
): Promise<number> {
  checkOwnerId(ownerId);
  if (!Number.isSafeInteger(requestBytes) || requestBytes <= 0) {
    throw new Error("Analytics Pipeline request size is invalid.");
  }
  if (!Number.isSafeInteger(bytesPerSecond) || bytesPerSecond <= 0) {
    throw new Error("Analytics Pipeline rate is invalid.");
  }
  const safeNow = checkedLease(ownerId, now, leaseDurationMs).now;
  const durationMs = Math.ceil((requestBytes / bytesPerSecond) * 1_000);
  const row = await db
    .prepare(
      `UPDATE analytics_export_lease
      SET send_available_at = MAX(send_available_at, ?) + ?,
        expires_at = MAX(expires_at, MAX(send_available_at, ?) + ? + ?)
      WHERE shard = 0 AND owner_id = ? AND expires_at > ?
      RETURNING send_available_at`,
    )
    .bind(safeNow, durationMs, safeNow, durationMs, leaseDurationMs, ownerId, safeNow)
    .first<SendWindowRow>();
  if (row === null) {
    throw new Error("Analytics export lease expired before reserving Pipeline capacity.");
  }
  return Math.max(0, row.send_available_at - durationMs - safeNow);
}

export async function releaseAnalyticsLease(
  db: D1Database,
  ownerId: string,
  now = Date.now(),
): Promise<void> {
  checkOwnerId(ownerId);
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error("Analytics lease has an invalid release time.");
  }
  await db
    .prepare(
      `UPDATE analytics_export_lease
      SET expires_at = MAX(acquired_at + 1, ?)
      WHERE shard = 0 AND owner_id = ?`,
    )
    .bind(now, ownerId)
    .run();
}

function checkedLease(
  ownerId: string,
  now: number,
  durationMs: number,
): { ownerId: string; now: number; expiresAt: number } {
  checkOwnerId(ownerId);
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error("Analytics lease has an invalid current time.");
  }
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error("Analytics lease has an invalid duration.");
  }
  const expiresAt = now + durationMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("Analytics lease expiry is too large.");
  }
  return { ownerId, now, expiresAt };
}

function checkOwnerId(ownerId: string): void {
  if (ownerId.length === 0 || ownerId.length > 200) {
    throw new Error("Analytics lease has an invalid owner id.");
  }
}
