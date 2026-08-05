import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { ANALYTICS_RETENTION_MS } from "@orange-replay/shared";

describe("recording and analytics retention migration", () => {
  it("reschedules legacy recording expiry without weakening privacy deletion", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE sessions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE session_deletions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY (project_id, session_id)
    );`);

    for (const migrationName of [
      "0009_analytics_warehouse.sql",
      "0016_analytics_deletion_started_at.sql",
      "0018_analytics_deletion_v2.sql",
    ]) {
      database.exec(
        await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), "utf8"),
      );
    }

    database.exec(`INSERT INTO sessions (project_id, session_id, started_at) VALUES
      ('project', 'recording-expired', 1000),
      ('project', 'privacy-delete', 1100);
    INSERT INTO session_deletions (project_id, session_id, requested_at) VALUES
      ('project', 'recording-expired', 2000),
      ('project', 'privacy-delete', 2100);
    INSERT INTO analytics_deletion_jobs (
      project_id, session_id, requested_at, delete_reason,
      requires_warehouse_tombstone, deletion_export_sequence, completed_at,
      session_started_at, deletion_v2_sent_at, deletion_v2_visible_at
    ) VALUES
      ('project', 'recording-expired', 2000, 'retention_expired', 1, 3, 2500, 1000, 2200, 2300),
      ('project', 'privacy-delete', 2100, 'delete_requested', 1, 4, NULL, 1100, 2200, 2300);
    INSERT INTO analytics_deletion_v2_state (
      shard, required_job_count, visible_job_count, backfill_completed_at
    ) VALUES (0, 2, 2, 2400);`);

    const migration = await readFile(
      new URL("../migrations/0025_separate_recording_and_analytics_retention.sql", import.meta.url),
      "utf8",
    );
    database.exec(migration);

    expect(
      database
        .prepare(
          `SELECT requested_at, delete_reason, deletion_export_sequence, completed_at,
            deletion_v2_sent_at, deletion_v2_visible_at
          FROM analytics_deletion_jobs
          WHERE session_id = 'recording-expired'`,
        )
        .get(),
    ).toEqual({
      completed_at: null,
      delete_reason: "analytics_retention_expired",
      deletion_export_sequence: null,
      deletion_v2_sent_at: null,
      deletion_v2_visible_at: null,
      requested_at: 1000 + ANALYTICS_RETENTION_MS,
    });
    expect(
      database
        .prepare(
          `SELECT session_id, delete_analytics
          FROM session_deletions ORDER BY session_id`,
        )
        .all(),
    ).toEqual([
      { delete_analytics: 1, session_id: "privacy-delete" },
      { delete_analytics: 0, session_id: "recording-expired" },
    ]);
    expect(
      database
        .prepare(
          `SELECT requested_at, delete_reason, deletion_export_sequence
          FROM analytics_deletion_jobs WHERE session_id = 'privacy-delete'`,
        )
        .get(),
    ).toEqual({
      delete_reason: "delete_requested",
      deletion_export_sequence: 4,
      requested_at: 2100,
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM analytics_deletion_v2_state").get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("keeps the self-host migration identical", async () => {
    const [hosted, selfHost] = await Promise.all([
      readFile(
        new URL(
          "../migrations/0025_separate_recording_and_analytics_retention.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../../infra/template/migrations/0025_separate_recording_and_analytics_retention.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    expect(selfHost).toBe(hosted);
  });
});
