#!/usr/bin/env python3
r"""Exercise the real purge runner against disposable local Iceberg tables.

Run in an already-built analytics image; its normal non-root user is retained:

    docker run --rm --network none --entrypoint python \
      -v "$PWD/infra/analytics/test_purge_iceberg.py:/app/test_purge_iceberg.py:ro" \
      analytics-purge-candidate /app/test_purge_iceberg.py

For an upgrade check, also bind an EMPTY directory writable by UID 10001 at
/warehouse. Run the old image with --warehouse /warehouse --seed-only, then the
candidate with --warehouse /warehouse --verify-only using the same mount path.
The default creates and removes its own temporary directory. An explicit
warehouse is left in place for inspection. No catalog credentials are needed.

This proves local Spark/Iceberg behavior, including physical file removal. It
does not exercise Cloudflare REST, R2 credentials, Pipelines, or D1 scheduling.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

try:
    from . import purge_pending
except ImportError:
    import purge_pending


DELETE_MODES = ("merge-on-read", "copy-on-write")
ALL_TABLES = purge_pending.DATA_TABLES + purge_pending.TOMBSTONE_TABLES
MARKER_NAME = ".orange-replay-local-iceberg-fixture.json"
FIXTURE_NAME = "orange-replay-local-iceberg-purge-v1"
PROJECT_ID = "fixture_project"
TARGET_SESSIONS = ("legacy_session", "v2_session")
FIRST_DAY = "2026-01-01 12:00:00"
OTHER_DAY = "2026-01-02 12:00:00"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def local_file(location: str, warehouse: Path) -> Path:
    parsed = urlsplit(location)
    require(
        parsed.scheme == "file"
        and not parsed.netloc
        and not parsed.query
        and not parsed.fragment,
        "Fixture files must use local file:// paths with no host.",
    )
    path = Path(unquote(parsed.path)).resolve()
    require(path.is_relative_to(warehouse), "A fixture file is outside its warehouse.")
    return path


def start_spark(warehouse: Path):
    from pyspark import SparkContext
    from pyspark.sql import SparkSession

    require(
        SparkContext._active_spark_context is None,
        "Run this fixture in its own process, with no existing Spark session.",
    )
    os.environ["SPARK_LOCAL_IP"] = "127.0.0.1"
    spark = (
        SparkSession.builder.master("local[2]")
        .appName("OrangeReplayLocalPurgeFixture")
        .config("spark.ui.enabled", "false")
        .config("spark.driver.host", "127.0.0.1")
        .config("spark.driver.bindAddress", "127.0.0.1")
        .config("spark.sql.shuffle.partitions", "1")
        .config("spark.sql.session.timeZone", "UTC")
        .config("spark.hadoop.fs.defaultFS", "file:///")
        .config(
            "spark.sql.extensions",
            "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions",
        )
        .config("spark.sql.catalog.r2", "org.apache.iceberg.spark.SparkCatalog")
        .config("spark.sql.catalog.r2.type", "hadoop")
        .config("spark.sql.catalog.r2.io-impl", "org.apache.iceberg.hadoop.HadoopFileIO")
        .config("spark.sql.catalog.r2.warehouse", warehouse.as_uri())
        .config("spark.sql.defaultCatalog", "r2")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("WARN")
    # The name r2 is only the runner's SQL alias; this catalog never uses REST/S3.
    require(spark.sparkContext.master == "local[2]", "Spark must run locally.")
    require(
        spark.conf.get("spark.sql.catalog.r2.type") == "hadoop",
        "Use HadoopCatalog only.",
    )
    local_file(spark.conf.get("spark.sql.catalog.r2.warehouse"), warehouse)
    return spark


def runtime_versions(spark) -> dict[str, str]:
    return {
        "python": platform.python_version(),
        "spark": spark.version,
        "iceberg": str(spark._jvm.org.apache.iceberg.IcebergBuild.fullVersion()),
        "java": str(spark._jvm.java.lang.System.getProperty("java.version")),
    }


def rows(spark, table: str) -> list[tuple[str, ...]]:
    result = spark.sql(
        "SELECT project_id, session_id, CAST(__ingest_ts AS STRING), marker "
        f"FROM r2.default.{table}"
    ).collect()
    return sorted(tuple(row) for row in result)


def snapshots(spark, table: str) -> list[int]:
    return sorted(
        int(row["snapshot_id"])
        for row in spark.sql(f"SELECT snapshot_id FROM r2.default.{table}.snapshots").collect()
    )


def file_hashes(spark, table: str, warehouse: Path) -> dict[str, str]:
    result = {}
    for row in spark.sql(f"SELECT file_path FROM r2.default.{table}.files").collect():
        path = local_file(row["file_path"], warehouse)
        result[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def metadata(spark, table: str, warehouse: Path) -> dict[str, Any]:
    iceberg_table = spark._jvm.org.apache.iceberg.spark.Spark3Util.loadIcebergTable(
        spark._jsparkSession, f"r2.default.{table}"
    )
    local_file(str(iceberg_table.location()), warehouse)
    location = str(iceberg_table.operations().current().metadataFileLocation())
    document = json.loads(local_file(location, warehouse).read_text())
    require(
        document["format-version"] == 2,
        f"{table} must remain in Iceberg format version 2.",
    )
    for row in spark.sql(f"SELECT file_path FROM r2.default.{table}.files").collect():
        require(
            local_file(row["file_path"], warehouse).is_file(),
            f"A current {table} file is missing.",
        )
    return document


def append_rows(spark, table: str, values: list[tuple[str, str, str, str]]) -> None:
    # Values are synthetic fixture constants. One input task puts each day's
    # targets and retained rows together, which the file assertions verify.
    sql_values = ", ".join(
        f"('{project}', '{session}', TIMESTAMP '{day}', '{marker}')"
        for project, session, day, marker in values
    )
    spark.sql(
        f"SELECT * FROM VALUES {sql_values} "
        "AS fixture_rows(project_id, session_id, __ingest_ts, marker)"
    ).coalesce(1).writeTo(f"r2.default.{table}").append()


def seed_rows() -> list[tuple[str, str, str, str]]:
    return [
        (PROJECT_ID, "legacy_session", FIRST_DAY, "delete_legacy"),
        (PROJECT_ID, "v2_session", FIRST_DAY, "delete_v2"),
        (PROJECT_ID, "missing_tombstone", FIRST_DAY, "keep_without_tombstone"),
        (PROJECT_ID, "kept_same_day", FIRST_DAY, "keep_same_file"),
        ("other_project", "legacy_session", FIRST_DAY, "keep_other_project"),
        (PROJECT_ID, "kept_other_day", OTHER_DAY, "keep_other_partition"),
    ]


def seed(spark, delete_mode: str) -> None:
    spark.sql("CREATE NAMESPACE r2.default")
    for table in ALL_TABLES:
        spark.sql(
            f"CREATE TABLE r2.default.{table} "
            "(project_id STRING, session_id STRING, __ingest_ts TIMESTAMP, marker STRING) "
            "USING iceberg PARTITIONED BY (days(__ingest_ts)) "
            f"TBLPROPERTIES ('format-version'='2', 'write.delete.mode'='{delete_mode}')"
        )
    values = seed_rows()
    for table in purge_pending.DATA_TABLES:
        append_rows(spark, table, values[:-1])
        append_rows(spark, table, values[-1:])
    for table, session in zip(purge_pending.TOMBSTONE_TABLES, TARGET_SESSIONS):
        append_rows(spark, table, [(PROJECT_ID, session, FIRST_DAY, "keep_tombstone")])


def claimed_job(
    session: str, tombstone_table: str, needs_maintenance: bool
) -> dict[str, Any]:
    return {
        "project_id": PROJECT_ID,
        "session_id": session,
        "requires_warehouse_tombstone": True,
        "tombstone_table": tombstone_table,
        "needs_physical_maintenance": needs_maintenance,
    }


def target_files(spark, table: str, warehouse: Path) -> set[Path]:
    result = spark.sql(
        f"SELECT DISTINCT _file FROM r2.default.{table} "
        f"WHERE project_id = '{PROJECT_ID}' "
        "AND session_id IN ('legacy_session', 'v2_session')"
    ).collect()
    return {local_file(row["_file"], warehouse) for row in result}


def check_retained_data(spark, expected: dict[str, list[tuple[str, ...]]]) -> None:
    for table, expected_rows in expected.items():
        require(
            rows(spark, table) == sorted(expected_rows),
            f"Unexpected retained rows in {table}.",
        )


def finish_batch(
    spark,
    pending,
    expected_tables: tuple[str, ...],
    expected_before: dict[str, int],
) -> None:
    cutoff, maintained = purge_pending.maintain_deleted_data(spark, pending)
    require(maintained == expected_tables, "Maintenance touched an unexpected set of tables.")
    require(
        bool(cutoff) == bool(expected_tables),
        "Snapshot expiry evidence does not match maintenance.",
    )
    verified = purge_pending.verify_job_batch_after_maintenance(spark, pending, cutoff, None)
    require(len(verified) == len(expected_before), "A purge result is missing.")
    require(
        {job["session_id"] for job, _result, _details in verified} == set(expected_before),
        "Purge results contain the wrong sessions.",
    )
    for job, result, details in verified:
        require("error" not in result, f"Purge verification failed: {result.get('error')}")
        require(result["rows_remaining"] == 0, "Deleted rows remain visible.")
        require(
            result["rows_found_before"] == expected_before[job["session_id"]],
            "The runner did not report the expected count before deletion.",
        )
        require(details["tombstones_kept"] == 1, "A deletion tombstone was lost.")


def verify(spark, warehouse: Path, delete_mode: str) -> dict[str, Any]:
    expected = {table: seed_rows() for table in purge_pending.DATA_TABLES}
    for table, session in zip(purge_pending.TOMBSTONE_TABLES, TARGET_SESSIONS):
        expected[table] = [(PROJECT_ID, session, FIRST_DAY, "keep_tombstone")]
    check_retained_data(spark, expected)
    old_files: dict[str, set[Path]] = {}
    other_partition_files: dict[str, set[Path]] = {}
    tombstone_snapshots = {
        table: snapshots(spark, table) for table in purge_pending.TOMBSTONE_TABLES
    }
    for table in ALL_TABLES:
        document = metadata(spark, table, warehouse)
        require(
            document["properties"]["write.delete.mode"] == delete_mode,
            "Wrong fixture delete mode.",
        )
    for table in purge_pending.DATA_TABLES:
        old_files[table] = target_files(spark, table, warehouse)
        require(len(old_files[table]) == 1, f"Targets must share one original {table} file.")
        file_rows = spark.sql(f"SELECT marker, _file FROM r2.default.{table}").collect()
        by_marker = {row["marker"]: local_file(row["_file"], warehouse) for row in file_rows}
        require(
            by_marker["keep_same_file"] in old_files[table]
            and by_marker["keep_without_tombstone"] in old_files[table]
            and by_marker["keep_other_project"] in old_files[table],
            "The fixture did not put retained rows beside deleted rows in one file.",
        )
        other_partition_files[table] = {by_marker["keep_other_partition"]}
        require(
            not old_files[table] & other_partition_files[table],
            "The other day must use a separate file.",
        )
        require(len(snapshots(spark, table)) == 2, "The seed must contain two data snapshots.")

    jobs = [
        claimed_job(session, table, True)
        for table, session in zip(purge_pending.TOMBSTONE_TABLES, TARGET_SESSIONS)
    ]
    denied_job = claimed_job("missing_tombstone", "analytics_deletions_v2", True)
    pending, rejected = purge_pending.delete_job_batch(spark, [*jobs, denied_job])
    require(
        len(pending) == 2 and len(rejected) == 1,
        "Eligible and denied jobs were not separated.",
    )
    denied, result, _details = rejected[0]
    require(denied["session_id"] == "missing_tombstone", "The wrong job was denied.")
    require(
        result.get("error") == "verified analytics deletion tombstone is missing",
        "A missing tombstone must block deletion.",
    )
    require(result["rows_remaining"] == 2, "The denied job's rows were removed.")
    for table in purge_pending.DATA_TABLES:
        expected[table] = [
            row for row in expected[table]
            if not (row[0] == PROJECT_ID and row[1] in TARGET_SESSIONS)
        ]
        require(
            all(path.is_file() for path in old_files[table]),
            "Historical files disappeared before snapshot expiry.",
        )
        if delete_mode == "merge-on-read":
            delete_files = spark.sql(
                f"SELECT COUNT(*) AS total FROM r2.default.{table}.files WHERE content = 1"
            ).first()["total"]
            require(
                delete_files > 0,
                "The merge-on-read fixture did not create position delete files.",
            )
    check_retained_data(spark, expected)
    finish_batch(
        spark, pending, purge_pending.DATA_TABLES,
        {session: 2 for session in TARGET_SESSIONS},
    )
    check_retained_data(spark, expected)
    first_zero_snapshots = {}
    for table in purge_pending.DATA_TABLES:
        require(
            all(not path.exists() for path in old_files[table]),
            "Deleted row bytes remain in an original data file.",
        )
        require(
            all(path.is_file() for path in other_partition_files[table]),
            "Maintenance removed an unrelated partition file.",
        )
        first_zero_snapshots[table] = snapshots(spark, table)
        require(
            len(first_zero_snapshots[table]) == 1,
            "Snapshot expiry did not retain exactly the current snapshot.",
        )

    # The scheduler supplies needs_physical_maintenance=False for a second zero
    # check. It must not produce a new snapshot or another physical rewrite.
    second_jobs = [{**job, "needs_physical_maintenance": False} for job in jobs]
    pending, rejected = purge_pending.delete_job_batch(spark, second_jobs)
    require(not rejected and len(pending) == 2, "The second zero check failed.")
    finish_batch(spark, pending, (), {session: 0 for session in TARGET_SESSIONS})
    for table in purge_pending.DATA_TABLES:
        require(
            snapshots(spark, table) == first_zero_snapshots[table],
            "The second zero check wrote a snapshot.",
        )
    check_retained_data(spark, expected)

    # A delayed Pipeline event arrives after both zero checks. The tombstone is
    # still present, and the positive before-count lets D1 reset its zero proof.
    session_files_before = file_hashes(spark, "analytics_sessions", warehouse)
    session_snapshots_before = set(snapshots(spark, "analytics_sessions"))
    late_rows = [
        (PROJECT_ID, "legacy_session", FIRST_DAY, "delete_late_event"),
        (PROJECT_ID, "kept_late_neighbor", FIRST_DAY, "keep_late_neighbor"),
    ]
    append_rows(spark, "analytics_events", late_rows)
    late_files = target_files(spark, "analytics_events", warehouse)
    require(len(late_files) == 1, "The late event must have one physical source file.")
    pending, rejected = purge_pending.delete_job_batch(spark, second_jobs)
    require(not rejected and len(pending) == 2, "The late event could not be deleted.")

    # The runner sends DELETE to both data tables when either has matching rows.
    # An empty session DELETE may commit one snapshot, but it must not change
    # any rows or physical data/delete files. Maintenance remains event-only.
    session_snapshots_after_delete = set(snapshots(spark, "analytics_sessions"))
    require(
        session_snapshots_before <= session_snapshots_after_delete,
        "The empty session delete removed an earlier snapshot.",
    )
    empty_session_snapshots = session_snapshots_after_delete - session_snapshots_before
    require(
        len(empty_session_snapshots) <= 1,
        "The empty session delete created more than one snapshot.",
    )
    require(
        rows(spark, "analytics_sessions") == sorted(expected["analytics_sessions"]),
        "The empty session delete changed retained rows.",
    )
    require(
        file_hashes(spark, "analytics_sessions", warehouse) == session_files_before,
        "The empty session delete changed a data or delete file.",
    )
    for snapshot_id in empty_session_snapshots:
        changed_files = spark.sql(
            "SELECT COUNT(*) AS total FROM r2.default.analytics_sessions.all_entries "
            f"WHERE snapshot_id = {snapshot_id} AND status IN (1, 2)"
        ).first()["total"]
        # Iceberg manifest entries use 1 for added files and 2 for deleted files.
        require(changed_files == 0, "An empty session snapshot added or deleted files.")

    finish_batch(spark, pending, ("analytics_events",), {"legacy_session": 1, "v2_session": 0})
    expected["analytics_events"].append(late_rows[1])
    check_retained_data(spark, expected)
    require(
        all(not path.exists() for path in late_files),
        "Late event bytes remain in a data file.",
    )
    require(
        set(snapshots(spark, "analytics_sessions")) == session_snapshots_after_delete,
        "Event-only maintenance changed session snapshots.",
    )
    require(
        file_hashes(spark, "analytics_sessions", warehouse) == session_files_before,
        "Event-only maintenance changed a session data or delete file.",
    )
    require(
        len(snapshots(spark, "analytics_events")) == 1,
        "Late event snapshots were not expired.",
    )
    for table in ALL_TABLES:
        metadata(spark, table, warehouse)
    for table in purge_pending.DATA_TABLES:
        require(
            all(path.is_file() for path in other_partition_files[table]),
            "Late event maintenance removed an unrelated partition file.",
        )
    for table in purge_pending.TOMBSTONE_TABLES:
        require(
            snapshots(spark, table) == tombstone_snapshots[table],
            "Purge changed a tombstone table's snapshots.",
        )
    return {
        "delete_mode": delete_mode,
        "original_data_files_removed": sum(len(paths) for paths in old_files.values()),
        "late_data_files_removed": len(late_files),
        "table_format": 2,
        "missing_tombstone_denied": True,
        "retained_rows_and_tombstones_unchanged": True,
        "second_zero_check_created_no_snapshot": True,
        "late_event_rows_found_before": 1,
        "late_empty_session_snapshots": len(empty_session_snapshots),
    }


def run(warehouse: Path, seed_only: bool, verify_only: bool) -> dict[str, Any]:
    marker_path = warehouse / MARKER_NAME
    previous = None
    if verify_only:
        require(marker_path.is_file(), "Verify only accepts a warehouse created by --seed-only.")
        previous = json.loads(marker_path.read_text())
        require(
            previous.get("fixture") == FIXTURE_NAME
            and previous.get("warehouse") == warehouse.as_uri()
            and previous.get("state") == "seeded",
            "Use an unverified fixture at the same local mount path used for seeding.",
        )
    else:
        require(
            not warehouse.exists() or not any(warehouse.iterdir()),
            "Seeding requires an empty directory.",
        )
        warehouse.mkdir(parents=True, exist_ok=True)

    results = []
    versions = None
    for delete_mode in DELETE_MODES:
        local_warehouse = warehouse / delete_mode
        if not verify_only:
            local_warehouse.mkdir()
        require(
            local_warehouse.is_dir() and not local_warehouse.is_symlink(),
            "Each delete mode must use its own local fixture directory.",
        )
        spark = start_spark(local_warehouse)
        try:
            versions = runtime_versions(spark)
            if not verify_only:
                seed(spark, delete_mode)
            if not seed_only:
                results.append(verify(spark, local_warehouse, delete_mode))
        finally:
            spark.stop()

    result = {
        "event": "analytics.local_iceberg_purge_fixture",
        "fixture": FIXTURE_NAME,
        "warehouse": warehouse.as_uri(),
        "state": "seeded" if seed_only else "verified",
        "seed_runtime": previous["seed_runtime"] if previous else versions,
        "runtime": versions,
        "checks": results,
    }
    marker_path.write_text(json.dumps(result, indent=2) + "\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--warehouse", help="Empty absolute local directory; URLs are rejected.")
    phase = parser.add_mutually_exclusive_group()
    phase.add_argument("--seed-only", action="store_true")
    phase.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    if (args.seed_only or args.verify_only) and not args.warehouse:
        parser.error("--seed-only and --verify-only require --warehouse.")
    if args.warehouse:
        candidate = Path(args.warehouse)
        if "://" in args.warehouse or not candidate.is_absolute() or candidate.is_symlink():
            parser.error("--warehouse must be an absolute local directory, not a URL or symlink.")
        result = run(candidate.resolve(), args.seed_only, args.verify_only)
    else:
        with tempfile.TemporaryDirectory(prefix="orange-replay-iceberg-") as directory:
            result = run(Path(directory).resolve(), False, False)
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
