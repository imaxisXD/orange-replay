#!/usr/bin/env python3
"""Delete claimed Orange Replay sessions from the R2 Iceberg warehouse.

The default is a local dry run that makes no network or catalog changes. Pass
--execute only from the scheduled runner. Secrets are read from environment
variables and are never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit


SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SAFE_OWNER = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
DATA_TABLES = ("analytics_events", "analytics_sessions")
TOMBSTONE_TABLE = "analytics_deletions"
CLAIM_PATH = "/internal/analytics/purge/claim"
REPORT_PATH = "/internal/analytics/purge/report"
MAX_RESPONSE_BYTES = 1024 * 1024
HTTP_TIMEOUT_SECONDS = 30
CLAIM_BATCH_SIZE = 500
REPORT_BATCH_SIZE = 20
MAX_JOBS_PER_RUN = 4_000
MAX_CLAIM_SECONDS = 20 * 60
MAX_RUN_SECONDS = 30 * 60
SCHEDULE_INTERVAL_MINUTES = 15
WORKFLOW_TIMEOUT_MINUTES = 40
LEASE_MINUTES = 45
ZERO_CHECKS_PER_JOB = 2
SCHEDULED_RUNS_PER_DAY = 24 * 60 // SCHEDULE_INTERVAL_MINUTES
WORST_CASE_RUNS_PER_DAY = min(
    SCHEDULED_RUNS_PER_DAY, 24 * 60 // WORKFLOW_TIMEOUT_MINUTES
)
MAX_COMPLETED_JOBS_PER_DAY = (
    MAX_JOBS_PER_RUN * WORST_CASE_RUNS_PER_DAY // ZERO_CHECKS_PER_JOB
)
BULK_DELETE_SLA_JOBS = 50_000


def read_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Process pending analytics deletions")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--owner-id")
    parser.add_argument("--api-url", default=os.environ.get("ORANGE_REPLAY_PURGE_API_URL"))
    parser.add_argument("--catalog-uri", default=os.environ.get("R2_CATALOG_URI"))
    parser.add_argument("--warehouse", default=os.environ.get("R2_SQL_WAREHOUSE"))
    return parser.parse_args()


def required_text(value: str | None, name: str) -> str:
    if value is None or not value.strip():
        raise ValueError(f"{name} is required")
    return value.strip()


def checked_id(value: object, name: str) -> str:
    if not isinstance(value, str) or SAFE_ID.fullmatch(value) is None:
        raise ValueError(f"{name} must use only letters, numbers, _ or -")
    return value


def checked_owner(value: str | None) -> str:
    owner = value or f"analytics-purge-{uuid.uuid4()}"
    if SAFE_OWNER.fullmatch(owner) is None:
        raise ValueError("owner id is invalid")
    return owner


def checked_api_url(value: str | None) -> str:
    url = required_text(value, "purge API URL").rstrip("/")
    parsed = urlsplit(url)
    is_local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (
        parsed.scheme not in ({"http", "https"} if is_local else {"https"})
        or not parsed.netloc
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("purge API URL must be an HTTPS origin without a path")
    return url


def checked_token(value: str | None, name: str) -> str:
    if value is None or not value:
        raise ValueError(f"{name} is required")
    token = value
    if len(token) < 32 or len(token) > 512 or token != token.strip():
        raise ValueError(f"{name} is invalid")
    return token


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_spark(catalog_uri: str, warehouse: str, token: str):
    from pyspark.sql import SparkSession

    return (
        SparkSession.builder.appName("OrangeReplayAnalyticsPurge")
        .config(
            "spark.jars.packages",
            "org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.6.1,"
            "org.apache.iceberg:iceberg-aws-bundle:1.6.1",
        )
        .config(
            "spark.sql.extensions",
            "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions",
        )
        .config("spark.sql.catalog.r2", "org.apache.iceberg.spark.SparkCatalog")
        .config("spark.sql.catalog.r2.type", "rest")
        .config("spark.sql.catalog.r2.uri", catalog_uri)
        .config("spark.sql.catalog.r2.warehouse", warehouse)
        .config("spark.sql.catalog.r2.token", token)
        .config(
            "spark.sql.catalog.r2.header.X-Iceberg-Access-Delegation",
            "vended-credentials",
        )
        .config("spark.sql.catalog.r2.s3.remote-signing-enabled", "false")
        .config("spark.sql.defaultCatalog", "r2")
        .getOrCreate()
    )


def post_json(api_url: str, path: str, token: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        api_url + path,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "orange-replay-analytics-purge/1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            encoded = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"purge API returned HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise RuntimeError("purge API could not be reached") from error

    if status < 200 or status >= 300:
        raise RuntimeError(f"purge API returned HTTP {status}")
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise RuntimeError("purge API response is too large")
    try:
        value = json.loads(encoded.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("purge API returned invalid JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError("purge API returned an invalid response")
    return value


def checked_claim(value: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    jobs = value.get("jobs")
    deadline_risk = value.get("deadline_risk")
    if (
        not isinstance(jobs, list)
        or len(jobs) > CLAIM_BATCH_SIZE
        or not isinstance(deadline_risk, bool)
    ):
        raise RuntimeError("purge API returned an invalid claim")
    checked_jobs: list[dict[str, Any]] = []
    seen_jobs: set[tuple[str, str]] = set()
    for job in jobs:
        if not isinstance(job, dict):
            raise RuntimeError("purge API returned an invalid job")
        project_id = checked_id(job.get("project_id"), "project id")
        session_id = checked_id(job.get("session_id"), "session id")
        requires_tombstone = job.get("requires_warehouse_tombstone")
        needs_maintenance = job.get("needs_physical_maintenance")
        if not isinstance(requires_tombstone, bool) or not isinstance(needs_maintenance, bool):
            raise RuntimeError("purge API returned an invalid deletion requirement")
        key = (project_id, session_id)
        if key in seen_jobs:
            raise RuntimeError("purge API returned the same job more than once")
        seen_jobs.add(key)
        checked_jobs.append(
            {
                "project_id": project_id,
                "session_id": session_id,
                "requires_warehouse_tombstone": requires_tombstone,
                "needs_physical_maintenance": needs_maintenance,
            }
        )
    return checked_jobs, deadline_risk


def job_key(job: dict[str, Any]) -> tuple[str, str]:
    return (str(job["project_id"]), str(job["session_id"]))


def jobs_predicate(jobs: list[dict[str, Any]]) -> str:
    if not jobs or len(jobs) > CLAIM_BATCH_SIZE:
        raise ValueError(f"analytics delete batch must contain 1 to {CLAIM_BATCH_SIZE} jobs")
    clauses: list[str] = []
    for job in jobs:
        project_id = checked_id(job.get("project_id"), "project id")
        session_id = checked_id(job.get("session_id"), "session id")
        clauses.append(
            "(project_id = "
            f"{sql_text(project_id)} AND session_id = {sql_text(session_id)})"
        )
    return " OR ".join(clauses)


def grouped_row_counts(
    spark, table: str, jobs: list[dict[str, Any]]
) -> dict[tuple[str, str], int]:
    expected = {job_key(job) for job in jobs}
    rows = spark.sql(
        "SELECT project_id, session_id, COUNT(*) AS rows "
        f"FROM r2.default.{table} WHERE {jobs_predicate(jobs)} "
        "GROUP BY project_id, session_id"
    ).collect()
    counts: dict[tuple[str, str], int] = {}
    for row in rows:
        key = (
            checked_id(row["project_id"], "warehouse project id"),
            checked_id(row["session_id"], "warehouse session id"),
        )
        count = int(row["rows"])
        if key not in expected or key in counts or count < 0:
            raise RuntimeError("warehouse count query returned an invalid row")
        counts[key] = count
    return counts


def data_row_counts(
    spark, jobs: list[dict[str, Any]]
) -> dict[tuple[str, str], dict[str, int]]:
    counts = {job_key(job): {table: 0 for table in DATA_TABLES} for job in jobs}
    for table in DATA_TABLES:
        for key, count in grouped_row_counts(spark, table, jobs).items():
            counts[key][table] = count
    return counts


def rows_total(counts: dict[str, int]) -> int:
    return sum(counts.get(table, 0) for table in DATA_TABLES)


def maintain_deleted_data(
    spark, pending: list[tuple[dict[str, Any], dict[str, Any]]]
) -> tuple[str | None, tuple[str, ...]]:
    jobs_by_table: dict[str, list[dict[str, Any]]] = {table: [] for table in DATA_TABLES}
    for job, details in pending:
        before = details.get("rows_before", {})
        for table in DATA_TABLES:
            if job["needs_physical_maintenance"] or int(before.get(table, 0)) > 0:
                jobs_by_table[table].append(job)

    maintained_tables: list[str] = []
    for table, jobs in jobs_by_table.items():
        if not jobs:
            continue
        where = jobs_predicate(jobs)
        spark.sql(
            "CALL r2.system.rewrite_data_files("
            f"table => 'default.{table}', where => {sql_text(where)}, "
            "options => map('min-input-files','1','delete-file-threshold','1'))"
        )
        maintained_tables.append(table)

    if not maintained_tables:
        return None, ()
    cutoff = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    for table in maintained_tables:
        spark.sql(
            "CALL r2.system.expire_snapshots("
            f"table => 'default.{table}', "
            f"older_than => TIMESTAMP '{cutoff}', retain_last => 1)"
        )
    return cutoff + "Z", tuple(maintained_tables)


def failed_result(
    job: dict[str, Any],
    before: dict[str, int],
    remaining: int,
    error: Exception,
) -> dict[str, Any]:
    return {
        "project_id": job["project_id"],
        "session_id": job["session_id"],
        "rows_remaining": remaining,
        "rows_found_before": rows_total(before),
        "error": simple_error(error),
    }


def delete_job_batch(
    spark, jobs: list[dict[str, Any]]
) -> tuple[
    list[tuple[dict[str, Any], dict[str, Any]]],
    list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]],
]:
    """Delete one bounded group with a fixed number of Spark table scans."""
    pending: list[tuple[dict[str, Any], dict[str, Any]]] = []
    ready: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    empty_counts = {table: 0 for table in DATA_TABLES}
    try:
        before_by_job = data_row_counts(spark, jobs)
    except Exception as error:
        for job in jobs:
            result = failed_result(job, empty_counts, 1, error)
            ready.append((job, result, {"rows_before": empty_counts}))
        return pending, ready

    tombstones_by_job: dict[tuple[str, str], int] = {}
    jobs_requiring_tombstones = [
        job for job in jobs if job["requires_warehouse_tombstone"]
    ]
    tombstone_error: Exception | None = None
    if jobs_requiring_tombstones:
        try:
            tombstones_by_job = grouped_row_counts(
                spark, TOMBSTONE_TABLE, jobs_requiring_tombstones
            )
        except Exception as error:
            tombstone_error = error

    jobs_ready_to_delete: list[dict[str, Any]] = []
    for job in jobs:
        key = job_key(job)
        before = before_by_job[key]
        tombstones = tombstones_by_job.get(key, 0)
        details = {"rows_before": before, "tombstones_kept": tombstones}
        if job["requires_warehouse_tombstone"] and tombstone_error is not None:
            ready.append(
                (job, failed_result(job, before, rows_total(before), tombstone_error), details)
            )
        elif job["requires_warehouse_tombstone"] and tombstones < 1:
            error = RuntimeError("verified analytics deletion tombstone is missing")
            ready.append((job, failed_result(job, before, rows_total(before), error), details))
        else:
            jobs_ready_to_delete.append(job)

    jobs_with_rows_or_cleanup = [
        job
        for job in jobs_ready_to_delete
        if job["needs_physical_maintenance"]
        or rows_total(before_by_job[job_key(job)]) > 0
    ]
    cleanup_keys = {job_key(job) for job in jobs_with_rows_or_cleanup}
    jobs_needing_only_second_check = [
        job for job in jobs_ready_to_delete if job_key(job) not in cleanup_keys
    ]
    for job in jobs_needing_only_second_check:
        key = job_key(job)
        pending.append(
            (
                job,
                {
                    "rows_before": before_by_job[key],
                    "rows_after_delete": empty_counts,
                    "tombstones_kept": tombstones_by_job.get(key, 0),
                },
            )
        )

    if not jobs_with_rows_or_cleanup:
        return pending, ready

    after_delete_by_job: dict[tuple[str, str], dict[str, int]] = {}
    try:
        predicate = jobs_predicate(jobs_with_rows_or_cleanup)
        # Never delete analytics_deletions. It remains the durable deny for a
        # late Pipeline row. Detail rows go before their session summary.
        spark.sql(f"DELETE FROM r2.default.analytics_events WHERE {predicate}")
        spark.sql(f"DELETE FROM r2.default.analytics_sessions WHERE {predicate}")
        after_delete_by_job = data_row_counts(spark, jobs_with_rows_or_cleanup)
    except Exception as error:
        try:
            after_delete_by_job = data_row_counts(spark, jobs_with_rows_or_cleanup)
        except Exception:
            after_delete_by_job = {}
        for job in jobs_with_rows_or_cleanup:
            key = job_key(job)
            before = before_by_job[key]
            after_delete = after_delete_by_job.get(key, empty_counts)
            remaining = max(1, rows_total(after_delete))
            details = {
                "rows_before": before,
                "rows_after_delete": after_delete,
                "tombstones_kept": tombstones_by_job.get(key, 0),
            }
            ready.append((job, failed_result(job, before, remaining, error), details))
        return pending, ready

    for job in jobs_with_rows_or_cleanup:
        key = job_key(job)
        before = before_by_job[key]
        after_delete = after_delete_by_job[key]
        details = {
            "rows_before": before,
            "rows_after_delete": after_delete,
            "tombstones_kept": tombstones_by_job.get(key, 0),
        }
        remaining = rows_total(after_delete)
        if remaining > 0:
            error = RuntimeError("analytics session rows remain after delete")
            ready.append((job, failed_result(job, before, remaining, error), details))
        else:
            pending.append((job, details))
    return pending, ready


def verify_job_batch_after_maintenance(
    spark,
    pending: list[tuple[dict[str, Any], dict[str, Any]]],
    snapshots_expired_at: str | None,
    maintenance_error: Exception | None,
) -> list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    jobs = [job for job, _details in pending]
    details_by_job = {job_key(job): details for job, details in pending}
    empty_counts = {table: 0 for table in DATA_TABLES}
    count_error: Exception | None = None
    try:
        after_by_job = data_row_counts(spark, jobs)
    except Exception as error:
        count_error = error
        after_by_job = {job_key(job): empty_counts for job in jobs}

    tombstone_error: Exception | None = None
    tombstones_by_job: dict[tuple[str, str], int] = {}
    jobs_requiring_tombstones = [
        job for job in jobs if job["requires_warehouse_tombstone"]
    ]
    if jobs_requiring_tombstones:
        try:
            tombstones_by_job = grouped_row_counts(
                spark, TOMBSTONE_TABLE, jobs_requiring_tombstones
            )
        except Exception as error:
            tombstone_error = error

    ready: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    for job in jobs:
        key = job_key(job)
        details = details_by_job[key]
        before = details.get("rows_before", empty_counts)
        after = after_by_job[key]
        tombstones = tombstones_by_job.get(key, 0)
        remaining = rows_total(after)
        error: Exception | None = count_error
        if error is None and maintenance_error is not None:
            error = RuntimeError(
                f"physical cleanup failed: {simple_error(maintenance_error)}"
            )
        if error is None and job["requires_warehouse_tombstone"]:
            if tombstone_error is not None:
                error = tombstone_error
            elif tombstones < 1:
                error = RuntimeError("analytics deletion tombstone disappeared")
        if error is None and remaining > 0:
            error = RuntimeError("analytics session rows remain after physical deletion")

        if error is None:
            result = {
                "project_id": job["project_id"],
                "session_id": job["session_id"],
                "rows_remaining": 0,
                "rows_found_before": rows_total(before),
            }
        else:
            safe_remaining = max(1, remaining) if count_error is not None else remaining
            result = failed_result(job, before, safe_remaining, error)
        ready.append(
            (
                job,
                result,
                {
                    **details,
                    "rows_after": after,
                    "tombstones_kept": tombstones,
                    "snapshots_expired_at": snapshots_expired_at,
                },
            )
        )
    return ready


def should_claim_another(claimed_jobs: int, started_at: float, now: float) -> bool:
    return claimed_jobs < MAX_JOBS_PER_RUN and now - started_at < MAX_CLAIM_SECONDS


def simple_error(error: Exception) -> str:
    message = str(error).strip() or error.__class__.__name__
    for name in ("ANALYTICS_PURGE_RUNNER_TOKEN", "ORANGE_REPLAY_CATALOG_TOKEN"):
        secret = os.environ.get(name)
        if secret:
            message = message.replace(secret, "[redacted]")
    message = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[redacted]", message)
    return message[:500]


def report_job_batch(
    api_url: str,
    runner_token: str,
    owner_id: str,
    jobs: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]],
    deadline_risk: bool,
) -> bool:
    if not jobs or len(jobs) > REPORT_BATCH_SIZE:
        raise ValueError(f"analytics report batch must contain 1 to {REPORT_BATCH_SIZE} jobs")
    reported: dict[str, Any] = {}
    report_error: str | None = None
    try:
        reported = post_json(
            api_url,
            REPORT_PATH,
            runner_token,
            {"owner_id": owner_id, "results": [result for _job, result, _details in jobs]},
        )
    except Exception as error:
        report_error = simple_error(error)

    for job, result, details in jobs:
        print(
            json.dumps(
                {
                    "event": "analytics.physical_delete_job",
                    "mode": "execute",
                    "project_id": job["project_id"],
                    "session_id": job["session_id"],
                    "rows_remaining": result["rows_remaining"],
                    "rows_found_before": result.get("rows_found_before", 0),
                    "failed": "error" in result or report_error is not None,
                    "error": result.get("error"),
                    "report_error": report_error,
                    "deadline_risk": deadline_risk,
                    "report": {
                        "completed": reported.get("completed"),
                        "waiting_for_second_check": reported.get("waiting_for_second_check"),
                        "failed": reported.get("failed"),
                    },
                    **details,
                },
                separators=(",", ":"),
            )
        )
    return report_error is None


def execute(args: argparse.Namespace) -> int:
    api_url = checked_api_url(args.api_url)
    runner_token = checked_token(
        os.environ.get("ANALYTICS_PURGE_RUNNER_TOKEN"), "purge runner token"
    )
    catalog_uri = required_text(args.catalog_uri, "catalog URI")
    warehouse = required_text(args.warehouse, "warehouse")
    catalog_token = checked_token(
        os.environ.get("ORANGE_REPLAY_CATALOG_TOKEN"), "catalog token"
    )
    owner_id = checked_owner(args.owner_id)
    started_at = time.monotonic()
    spark = None
    ready_to_report: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    jobs_claimed = 0
    jobs_reported = 0
    jobs_failed = 0
    report_failures = 0
    deadline_risk = False
    stop_reason = "no_work"
    run_error: str | None = None

    # Claims and Spark work stay bounded. Results remain leased until all
    # claiming stops, so one failed old job cannot starve newer deletions.
    try:
        while should_claim_another(jobs_claimed, started_at, time.monotonic()):
            claim_limit = min(CLAIM_BATCH_SIZE, MAX_JOBS_PER_RUN - jobs_claimed)
            try:
                claim = post_json(
                    api_url,
                    CLAIM_PATH,
                    runner_token,
                    {"owner_id": owner_id, "limit": claim_limit},
                )
                jobs, claim_deadline_risk = checked_claim(claim)
                if len(jobs) > claim_limit:
                    raise RuntimeError("purge API returned too many jobs")
                deadline_risk = deadline_risk or claim_deadline_risk
            except Exception as error:
                run_error = simple_error(error)
                stop_reason = "claim_failed"
                break

            if not jobs:
                stop_reason = "no_work"
                break
            jobs_claimed += len(jobs)

            if spark is None:
                try:
                    spark = build_spark(catalog_uri, warehouse, catalog_token)
                except Exception as error:
                    empty_counts = {table: 0 for table in DATA_TABLES}
                    for job in jobs:
                        result = failed_result(job, empty_counts, 1, error)
                        ready_to_report.append((job, result, {}))
                    run_error = "Spark could not start"
                    stop_reason = "spark_start_failed"
                    break

            pending, batch_ready = delete_job_batch(spark, jobs)
            ready_to_report.extend(batch_ready)

            if pending:
                maintenance_error: Exception | None = None
                snapshots_expired_at: str | None = None
                maintained_tables: tuple[str, ...] = ()
                try:
                    snapshots_expired_at, maintained_tables = maintain_deleted_data(
                        spark, pending
                    )
                except Exception as error:
                    maintenance_error = error

                verified = verify_job_batch_after_maintenance(
                    spark,
                    pending,
                    snapshots_expired_at,
                    maintenance_error,
                )
                for job, result, details in verified:
                    details["tables_maintained"] = maintained_tables
                    ready_to_report.append((job, result, details))

            if len(jobs) < claim_limit:
                stop_reason = "queue_drained"
                break
        else:
            stop_reason = "job_limit" if jobs_claimed >= MAX_JOBS_PER_RUN else "time_limit"
    finally:
        if spark is not None:
            try:
                spark.stop()
            except Exception as error:
                run_error = run_error or simple_error(error)

    for _job, result, _details in ready_to_report:
        if "error" in result or result["rows_remaining"] != 0:
            jobs_failed += 1

    for offset in range(0, len(ready_to_report), REPORT_BATCH_SIZE):
        report_batch = ready_to_report[offset : offset + REPORT_BATCH_SIZE]
        if report_job_batch(api_url, runner_token, owner_id, report_batch, deadline_risk):
            jobs_reported += len(report_batch)
        else:
            report_failures += 1
            run_error = run_error or "A purge result batch could not be reported"
            break

    jobs_unreported = len(ready_to_report) - jobs_reported

    print(
        json.dumps(
            {
                "event": "analytics.physical_delete_runner",
                "mode": "execute",
                "jobs_claimed": jobs_claimed,
                "jobs_reported": jobs_reported,
                "jobs_failed": jobs_failed,
                "report_failures": report_failures,
                "jobs_unreported": jobs_unreported,
                "stop_reason": stop_reason,
                "error": run_error,
                "deadline_risk": deadline_risk,
                "jobs_per_claim": CLAIM_BATCH_SIZE,
                "jobs_per_report": REPORT_BATCH_SIZE,
                "max_jobs_per_run": MAX_JOBS_PER_RUN,
                "max_claim_seconds": MAX_CLAIM_SECONDS,
                "max_run_seconds": MAX_RUN_SECONDS,
                "worst_case_runs_per_day": WORST_CASE_RUNS_PER_DAY,
                "max_completed_jobs_per_day": MAX_COMPLETED_JOBS_PER_DAY,
                "supported_bulk_delete_jobs": BULK_DELETE_SLA_JOBS,
            },
            separators=(",", ":"),
        )
    )
    if run_error is not None or jobs_failed > 0 or report_failures > 0:
        return 1
    return 2 if deadline_risk else 0


def dry_run(args: argparse.Namespace) -> int:
    checked_owner(args.owner_id)
    print(
        json.dumps(
            {
                "event": "analytics.physical_delete_runner",
                "mode": "dry_run",
                "external_calls": 0,
                "jobs_per_claim": CLAIM_BATCH_SIZE,
                "jobs_per_report": REPORT_BATCH_SIZE,
                "max_jobs_per_run": MAX_JOBS_PER_RUN,
                "max_claim_seconds": MAX_CLAIM_SECONDS,
                "max_run_seconds": MAX_RUN_SECONDS,
                "worst_case_runs_per_day": WORST_CASE_RUNS_PER_DAY,
                "max_completed_jobs_per_day": MAX_COMPLETED_JOBS_PER_DAY,
                "supported_bulk_delete_jobs": BULK_DELETE_SLA_JOBS,
                "execute_flag_required": True,
            },
            separators=(",", ":"),
        )
    )
    return 0


def main() -> int:
    args = read_arguments()
    return execute(args) if args.execute else dry_run(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # Fail closed with a simple operator message.
        print(simple_error(error), file=sys.stderr)
        sys.exit(1)
