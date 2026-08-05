from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import unittest
from pathlib import Path
from unittest import mock

from infra.analytics import purge_pending


class FakeSpark:
    def __init__(self) -> None:
        self.stop_calls = 0

    def stop(self) -> None:
        self.stop_calls += 1


class RecordingSpark:
    def __init__(self) -> None:
        self.queries: list[str] = []

    def sql(self, query: str) -> None:
        self.queries.append(query)


class CollectedRows:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows

    def collect(self) -> list[dict[str, object]]:
        return self.rows


class CountSpark:
    def __init__(self) -> None:
        self.queries: list[str] = []

    def sql(self, query: str) -> CollectedRows:
        self.queries.append(query)
        return CollectedRows([])


def job(number: int) -> dict[str, object]:
    return {
        "project_id": f"project-{number}",
        "session_id": f"session-{number}",
        "requires_warehouse_tombstone": False,
        "needs_physical_maintenance": True,
    }


def claimed_jobs(*numbers: int) -> dict[str, object]:
    return {
        "jobs": [job(number) for number in numbers],
        "deadline_risk": False,
    }


class PurgePendingRunnerTest(unittest.TestCase):
    def test_loop_limits_have_clear_boundaries(self) -> None:
        self.assertTrue(purge_pending.should_claim_another(0, 100, 100))
        self.assertFalse(
            purge_pending.should_claim_another(purge_pending.MAX_JOBS_PER_RUN, 100, 100)
        )
        self.assertFalse(
            purge_pending.should_claim_another(
                0, 100, 100 + purge_pending.MAX_CLAIM_SECONDS
            )
        )

    def test_capacity_uses_timeout_overlap_and_has_bulk_delete_headroom(self) -> None:
        self.assertEqual(purge_pending.RUNNER_HARD_TIMEOUT_MINUTES, 40)
        self.assertLess(
            purge_pending.MAX_RUN_SECONDS,
            purge_pending.RUNNER_HARD_TIMEOUT_MINUTES * 60,
        )
        self.assertLess(
            purge_pending.RUNNER_HARD_TIMEOUT_MINUTES,
            purge_pending.LEASE_MINUTES,
        )
        self.assertEqual(
            purge_pending.WORST_CASE_RUNS_PER_DAY,
            24 * 60 // purge_pending.RUNNER_HARD_TIMEOUT_MINUTES,
        )
        self.assertEqual(purge_pending.WORST_CASE_RUNS_PER_DAY, 36)
        self.assertEqual(purge_pending.MAX_COMPLETED_JOBS_PER_DAY, 72_000)
        self.assertGreaterEqual(
            purge_pending.MAX_COMPLETED_JOBS_PER_DAY,
            purge_pending.BULK_DELETE_SLA_JOBS,
        )
        self.assertEqual(purge_pending.BULK_DELETE_SLA_JOBS, 50_000)
        self.assertEqual(
            purge_pending.MAX_JOBS_PER_RUN % purge_pending.CLAIM_BATCH_SIZE,
            0,
        )

    def test_five_hundred_jobs_use_two_count_queries(self) -> None:
        jobs = [job(number) for number in range(purge_pending.CLAIM_BATCH_SIZE)]
        spark = CountSpark()

        counts = purge_pending.data_row_counts(spark, jobs)

        self.assertEqual(len(counts), purge_pending.CLAIM_BATCH_SIZE)
        self.assertEqual(len(spark.queries), len(purge_pending.DATA_TABLES))
        self.assertTrue(all("GROUP BY project_id, session_id" in query for query in spark.queries))
        self.assertTrue(all("project-499" in query for query in spark.queries))

    def test_five_hundred_jobs_use_two_delete_statements(self) -> None:
        jobs = [job(number) for number in range(purge_pending.CLAIM_BATCH_SIZE)]
        zero = {table: 0 for table in purge_pending.DATA_TABLES}
        counts = {purge_pending.job_key(claimed): zero for claimed in jobs}
        spark = RecordingSpark()

        with mock.patch.object(
            purge_pending,
            "data_row_counts",
            side_effect=[counts, counts],
        ):
            pending, ready = purge_pending.delete_job_batch(spark, jobs)

        deletes = [query for query in spark.queries if query.startswith("DELETE FROM")]
        self.assertEqual(len(pending), purge_pending.CLAIM_BATCH_SIZE)
        self.assertEqual(ready, [])
        self.assertEqual(len(deletes), len(purge_pending.DATA_TABLES))
        self.assertTrue(all("project-499" in query for query in deletes))

    def test_claim_uses_the_verified_tombstone_table_for_each_job(self) -> None:
        checked, deadline_risk = purge_pending.checked_claim(
            {
                "jobs": [
                    {
                        **job(1),
                        "requires_warehouse_tombstone": True,
                        "tombstone_table": "analytics_deletions",
                    },
                    {
                        **job(2),
                        "requires_warehouse_tombstone": True,
                        "tombstone_table": "analytics_deletions_v2",
                    },
                    job(3),
                ],
                "deadline_risk": False,
            }
        )
        self.assertFalse(deadline_risk)
        self.assertEqual(
            [claimed["tombstone_table"] for claimed in checked],
            ["analytics_deletions", "analytics_deletions_v2", None],
        )

        spark = CountSpark()
        self.assertEqual(purge_pending.tombstone_row_counts(spark, checked[:2]), {})
        self.assertEqual(len(spark.queries), 2)
        self.assertIn("r2.default.analytics_deletions ", spark.queries[0])
        self.assertIn("r2.default.analytics_deletions_v2 ", spark.queries[1])

    def test_old_claim_response_defaults_to_the_legacy_tombstone_table(self) -> None:
        checked, _deadline_risk = purge_pending.checked_claim(
            {
                "jobs": [
                    {
                        **job(1),
                        "requires_warehouse_tombstone": True,
                    }
                ],
                "deadline_risk": False,
            }
        )
        self.assertEqual(checked[0]["tombstone_table"], "analytics_deletions")

    def test_claim_rejects_an_unknown_tombstone_table(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "invalid tombstone table"):
            purge_pending.checked_claim(
                {
                    "jobs": [
                        {
                            **job(1),
                            "requires_warehouse_tombstone": True,
                            "tombstone_table": "analytics_deletions; DROP TABLE",
                        }
                    ],
                    "deadline_risk": False,
                }
            )

    def test_maintenance_is_scoped_and_second_zero_skips_compaction(self) -> None:
        first_check = (
            {
                "project_id": "project-1",
                "session_id": "session-1",
                "needs_physical_maintenance": True,
            },
            {"rows_before": {"analytics_events": 0, "analytics_sessions": 0}},
        )
        spark = RecordingSpark()
        _cutoff, maintained = purge_pending.maintain_deleted_data(spark, [first_check])

        rewrites = [query for query in spark.queries if "rewrite_data_files" in query]
        self.assertEqual(maintained, purge_pending.DATA_TABLES)
        self.assertEqual(len(rewrites), 2)
        for query in rewrites:
            self.assertIn("where =>", query)
            self.assertIn("project-1", query)
            self.assertIn("session-1", query)
            self.assertIn(
                "where => '(project_id = \\'project-1\\' AND session_id = \\'session-1\\')'",
                query,
            )
            self.assertNotIn("''project-1''", query)
            self.assertIn("'delete-file-threshold','1'", query)
            self.assertNotIn("analytics_deletions", query)

        second_check = (
            {
                "project_id": "project-1",
                "session_id": "session-1",
                "needs_physical_maintenance": False,
            },
            {"rows_before": {"analytics_events": 0, "analytics_sessions": 0}},
        )
        second_spark = RecordingSpark()
        self.assertEqual(
            purge_pending.maintain_deleted_data(second_spark, [second_check]),
            (None, ()),
        )
        self.assertEqual(second_spark.queries, [])

        late_event = (
            {
                "project_id": "project-1",
                "session_id": "session-1",
                "needs_physical_maintenance": False,
            },
            {"rows_before": {"analytics_events": 1, "analytics_sessions": 0}},
        )
        late_spark = RecordingSpark()
        _cutoff, late_tables = purge_pending.maintain_deleted_data(late_spark, [late_event])
        self.assertEqual(late_tables, ("analytics_events",))
        self.assertEqual(
            len([query for query in late_spark.queries if "rewrite_data_files" in query]),
            1,
        )

    def test_cloudflare_container_runs_on_schedule_with_required_secrets(self) -> None:
        root = Path(__file__).resolve().parents[2]
        config = (root / "apps" / "analytics-purge" / "wrangler.jsonc").read_text(
            encoding="utf-8"
        )
        worker = (root / "apps" / "analytics-purge" / "src" / "index.ts").read_text(
            encoding="utf-8"
        )
        image = (root / "infra" / "analytics" / "Dockerfile").read_text(
            encoding="utf-8"
        )
        image_prep = (
            root / "infra" / "analytics" / "prepare_spark_image.py"
        ).read_text(encoding="utf-8")
        runner = (root / "infra" / "analytics" / "purge_pending.py").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            f'"crons": ["*/{purge_pending.SCHEDULE_INTERVAL_MINUTES} * * * *"]',
            config,
        )
        self.assertIn('"max_instances": 1', config)
        self.assertIn('"instance_type": "standard-2"', config)
        self.assertIn('"rollout_active_grace_period": 1800', config)
        self.assertIn("ANALYTICS_PURGE_RUNNER_TOKEN", config)
        self.assertIn("ORANGE_REPLAY_CATALOG_TOKEN", config)
        self.assertIn("getContainer(env.ANALYTICS_PURGE_CONTAINER)", worker)
        self.assertIn('"--kill-after=30s", "40m", "python"', image)
        self.assertIn('"/app/purge_pending.py", "--execute"', image)
        self.assertIn("python /tmp/prepare_spark_image.py", image)
        self.assertIn("iceberg-spark-runtime-3.5_2.12-1.6.1.jar", image_prep)
        self.assertIn("iceberg-aws-bundle-1.6.1.jar", image_prep)
        self.assertIn(
            "87e7184f31ef0caac415bbdfcf1bc4943346a58b98d747dc83434f7139e12acb",
            image_prep,
        )
        self.assertIn(
            "d14a49ced66a20cbd30f73ebb379646248d784fc5cd49d7295d36524380330e3",
            image_prep,
        )
        self.assertNotIn("spark.jars.packages", runner)
        self.assertIn('sleepAfter = "45m"', worker)
        self.assertFalse((root / ".github" / "workflows" / "analytics-purge.yml").exists())

    def test_deadline_risk_without_claimable_work_is_a_warning(self) -> None:
        arguments = argparse.Namespace(
            api_url="https://purge.example",
            catalog_uri="https://catalog.example",
            warehouse="warehouse",
            owner_id="runner-warning",
        )
        with (
            mock.patch.dict(
                os.environ,
                {
                    "ANALYTICS_PURGE_RUNNER_TOKEN": "r" * 40,
                    "ORANGE_REPLAY_CATALOG_TOKEN": "c" * 40,
                },
                clear=False,
            ),
            mock.patch.object(
                purge_pending,
                "post_json",
                return_value={"jobs": [], "deadline_risk": True},
            ),
            mock.patch.object(purge_pending, "build_spark") as build,
            mock.patch.object(purge_pending.time, "monotonic", side_effect=[0, 1]),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            exit_code = purge_pending.execute(arguments)

        self.assertEqual(exit_code, 0)
        build.assert_not_called()
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[-1]["event"], "analytics.physical_delete_deadline_risk")

    def test_one_run_claims_deletes_and_reports_as_batches(self) -> None:
        claims = iter([claimed_jobs(1, 2)])
        claim_bodies: list[dict[str, object]] = []
        report_bodies: list[dict[str, object]] = []

        def fake_post_json(
            _api_url: str,
            path: str,
            _token: str,
            body: dict[str, object],
        ) -> dict[str, object]:
            if path == purge_pending.CLAIM_PATH:
                claim_bodies.append(body)
                return next(claims)
            report_bodies.append(body)
            return {"completed": 0, "waiting_for_second_check": 1, "failed": 0}

        spark = FakeSpark()
        arguments = argparse.Namespace(
            api_url="https://purge.example",
            catalog_uri="https://catalog.example",
            warehouse="warehouse",
            owner_id="runner-test",
        )

        def fake_delete_batch(_spark: FakeSpark, jobs: list[dict[str, object]]):
            return [
                (claimed, {"deleted_session": claimed["session_id"]})
                for claimed in jobs
            ], []

        def fake_verify_batch(
            _spark: FakeSpark,
            pending: list[tuple[dict[str, object], dict[str, object]]],
            snapshots_expired_at: str | None,
            maintenance_error: Exception | None,
        ):
            self.assertIsNone(maintenance_error)
            return [
                (
                    claimed,
                    {
                        "project_id": claimed["project_id"],
                        "session_id": claimed["session_id"],
                        "rows_remaining": 0,
                        "rows_found_before": 0,
                    },
                    {**details, "snapshots_expired_at": snapshots_expired_at},
                )
                for claimed, details in pending
            ]

        with (
            mock.patch.dict(
                os.environ,
                {
                    "ANALYTICS_PURGE_RUNNER_TOKEN": "r" * 40,
                    "ORANGE_REPLAY_CATALOG_TOKEN": "c" * 40,
                },
                clear=False,
            ),
            mock.patch.object(purge_pending, "post_json", side_effect=fake_post_json),
            mock.patch.object(purge_pending, "build_spark", return_value=spark) as build,
            mock.patch.object(
                purge_pending, "delete_job_batch", side_effect=fake_delete_batch
            ),
            mock.patch.object(
                purge_pending,
                "maintain_deleted_data",
                return_value=(
                    "2026-07-13T12:00:00.000Z",
                    purge_pending.DATA_TABLES,
                ),
            ) as maintain,
            mock.patch.object(
                purge_pending,
                "verify_job_batch_after_maintenance",
                side_effect=fake_verify_batch,
            ),
            mock.patch.object(purge_pending.time, "monotonic", side_effect=[0, 1]),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            exit_code = purge_pending.execute(arguments)

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            claim_bodies,
            [{"owner_id": "runner-test", "limit": purge_pending.CLAIM_BATCH_SIZE}],
        )
        self.assertEqual(len(report_bodies), 1)
        self.assertEqual(len(report_bodies[0]["results"]), 2)
        build.assert_called_once()
        maintain.assert_called_once()
        self.assertIs(maintain.call_args.args[0], spark)
        self.assertEqual(len(maintain.call_args.args[1]), 2)
        self.assertEqual(spark.stop_calls, 1)
        summary = json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual(summary["jobs_claimed"], 2)
        self.assertEqual(summary["jobs_reported"], 2)

    def test_failed_job_stays_leased_while_later_batch_is_claimed(self) -> None:
        claims = iter([claimed_jobs(1, 2), claimed_jobs(3)])
        request_paths: list[str] = []

        def fake_post_json(
            _api_url: str,
            path: str,
            _token: str,
            _body: dict[str, object],
        ) -> dict[str, object]:
            request_paths.append(path)
            if path == purge_pending.CLAIM_PATH:
                return next(claims)
            return {"completed": 0, "waiting_for_second_check": 0, "failed": 0}

        def fake_delete_batch(_spark: FakeSpark, jobs: list[dict[str, object]]):
            pending = [
                (claimed, {"rows_before": {"analytics_events": 1}})
                for claimed in jobs
                if claimed["session_id"] != "session-1"
            ]
            ready = []
            for claimed in jobs:
                if claimed["session_id"] == "session-1":
                    ready.append(
                        (
                            claimed,
                            {
                                "project_id": claimed["project_id"],
                                "session_id": claimed["session_id"],
                                "rows_remaining": 1,
                                "rows_found_before": 1,
                                "error": "repeatable delete failure",
                            },
                            {},
                        )
                    )
            return pending, ready

        def fake_verify_batch(
            _spark: FakeSpark,
            pending: list[tuple[dict[str, object], dict[str, object]]],
            _snapshots_expired_at: str | None,
            _maintenance_error: Exception | None,
        ):
            return [
                (
                    claimed,
                    {
                        "project_id": claimed["project_id"],
                        "session_id": claimed["session_id"],
                        "rows_remaining": 0,
                        "rows_found_before": 0,
                    },
                    details,
                )
                for claimed, details in pending
            ]

        arguments = argparse.Namespace(
            api_url="https://purge.example",
            catalog_uri="https://catalog.example",
            warehouse="warehouse",
            owner_id="runner-failure-test",
        )
        spark = FakeSpark()
        with (
            mock.patch.dict(
                os.environ,
                {
                    "ANALYTICS_PURGE_RUNNER_TOKEN": "r" * 40,
                    "ORANGE_REPLAY_CATALOG_TOKEN": "c" * 40,
                },
                clear=False,
            ),
            mock.patch.object(purge_pending, "post_json", side_effect=fake_post_json),
            mock.patch.object(purge_pending, "build_spark", return_value=spark),
            mock.patch.object(purge_pending, "CLAIM_BATCH_SIZE", 2),
            mock.patch.object(
                purge_pending, "delete_job_batch", side_effect=fake_delete_batch
            ),
            mock.patch.object(
                purge_pending,
                "maintain_deleted_data",
                return_value=("2026-07-13T12:00:00.000Z", ("analytics_events",)),
            ),
            mock.patch.object(
                purge_pending,
                "verify_job_batch_after_maintenance",
                side_effect=fake_verify_batch,
            ),
            mock.patch.object(purge_pending.time, "monotonic", side_effect=[0, 1, 2]),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            exit_code = purge_pending.execute(arguments)

        self.assertEqual(exit_code, 1)
        self.assertEqual(request_paths[:2], [purge_pending.CLAIM_PATH] * 2)
        self.assertEqual(request_paths[2:], [purge_pending.REPORT_PATH])


if __name__ == "__main__":
    unittest.main()
