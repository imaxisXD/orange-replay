import { describe, expect, it } from "vite-plus/test";
import {
  analyticsBaseSchemaKeys,
  buildHistoryRepairSql,
  canonicalAnalyticsDeletionJobSql,
  missingSchemaKeys,
  oldAnalyticsDeletionJobColumnShapes,
  oldAnalyticsDeletionJobSql,
  planAnalyticsDeletionJobRepair,
  planKnownMigrationHistoryRepair,
  requiredSchemaObjectNames,
  schemaObjectDifferences,
  shouldRepairLocalMigrationHistory,
} from "./local-d1-migration-repair.mjs";

describe("local D1 migration history repair", () => {
  it("maps the oldest applied names to the canonical files", () => {
    expect(
      planKnownMigrationHistoryRepair([
        "0009_hosted_auth.sql",
        "0010_key_cache_sync.sql",
        "0011_key_cache_final_check.sql",
        "0012_key_cache_write_jobs.sql",
      ]),
    ).toEqual({
      historyName: "old 0009-0012",
      mappings: [
        { from: "0009_hosted_auth.sql", to: "0011_hosted_auth.sql" },
        { from: "0010_key_cache_sync.sql", to: "0012_key_cache_sync.sql" },
        { from: "0011_key_cache_final_check.sql", to: "0013_key_cache_final_check.sql" },
        { from: "0012_key_cache_write_jobs.sql", to: "0014_key_cache_write_jobs.sql" },
      ],
    });
  });

  it("maps the later names including public pages", () => {
    expect(
      planKnownMigrationHistoryRepair([
        "0010_hosted_auth.sql",
        "0011_key_cache_sync.sql",
        "0012_key_cache_final_check.sql",
        "0013_key_cache_write_jobs.sql",
        "0014_public_pages.sql",
      ])?.mappings,
    ).toEqual([
      { from: "0010_hosted_auth.sql", to: "0011_hosted_auth.sql" },
      { from: "0011_key_cache_sync.sql", to: "0012_key_cache_sync.sql" },
      { from: "0012_key_cache_final_check.sql", to: "0013_key_cache_final_check.sql" },
      { from: "0013_key_cache_write_jobs.sql", to: "0014_key_cache_write_jobs.sql" },
      { from: "0014_public_pages.sql", to: "0015_public_pages.sql" },
    ]);
  });

  it("leaves fresh and canonical histories alone", () => {
    expect(planKnownMigrationHistoryRepair([])).toBeNull();
    expect(planKnownMigrationHistoryRepair(["0011_hosted_auth.sql"])).toBeNull();
  });

  it.each([
    ["mixed histories", ["0009_hosted_auth.sql", "0010_hosted_auth.sql"]],
    ["legacy and canonical names", ["0009_hosted_auth.sql", "0011_hosted_auth.sql"]],
    ["a history gap", ["0009_hosted_auth.sql", "0011_key_cache_final_check.sql"]],
  ])("stops on %s", (_name, applied) => {
    expect(() => planKnownMigrationHistoryRepair(applied)).toThrow(
      "Local D1 migration repair stopped",
    );
  });

  it("runs only for an unambiguous explicit local apply", () => {
    expect(shouldRepairLocalMigrationHistory(["--local"])).toBe(true);
    expect(shouldRepairLocalMigrationHistory(["--local=true"])).toBe(true);
    expect(shouldRepairLocalMigrationHistory(["--remote"])).toBe(false);
    expect(shouldRepairLocalMigrationHistory([])).toBe(false);
    expect(() => shouldRepairLocalMigrationHistory(["--local", "--remote"])).toThrow(
      "--local cannot be combined",
    );
  });

  it("builds one migration-ledger update statement", () => {
    const sql = buildHistoryRepairSql([
      { from: "0009_hosted_auth.sql", to: "0011_hosted_auth.sql" },
      { from: "0010_key_cache_sync.sql", to: "0012_key_cache_sync.sql" },
    ]);
    expect(sql).toContain("UPDATE d1_migrations");
    expect(sql).toContain("CASE name");
    expect(sql).toContain("'0009_hosted_auth.sql'");
    expect(sql).toContain("'0012_key_cache_sync.sql'");
  });

  it("reports missing schema before a history rename", () => {
    expect(missingSchemaKeys(["table:users", "index:idx_users_email"], ["table:users"])).toEqual([
      "index:idx_users_email",
    ]);
  });

  it("includes changed tables and indexes in the exact schema proof", () => {
    expect(requiredSchemaObjectNames(["0012_key_cache_sync.sql"])).toEqual([
      "idx_keys_cache_sync",
      "keys",
    ]);
  });

  it("rejects changed table constraints and index definitions", () => {
    expect(
      schemaObjectDifferences(
        [
          { type: "table", name: "users", sql: "CREATE TABLE users (id TEXT NOT NULL)" },
          { type: "index", name: "idx_users", sql: "CREATE INDEX idx_users ON users(id)" },
        ],
        [
          { type: "table", name: "users", sql: "CREATE TABLE users (id INTEGER NOT NULL)" },
          {
            type: "index",
            name: "idx_users",
            sql: "CREATE UNIQUE INDEX idx_users ON users(id)",
          },
        ],
      ),
    ).toEqual([
      "index:idx_users has a different definition",
      "table:users has a different definition",
    ]);
  });
});

describe("local analytics 0009 repair", () => {
  const oldColumns = oldAnalyticsDeletionJobColumnShapes.map((column) => ({ ...column }));

  it("adds the tombstone column only to the exact known old shape", () => {
    expect(
      planAnalyticsDeletionJobRepair({
        migrationApplied: true,
        baseSchemaMissing: [],
        columns: oldColumns,
        tableSql: oldAnalyticsDeletionJobSql,
      }),
    ).toBe("add_tombstone_column");
  });

  it("accepts the canonical tombstone column", () => {
    expect(
      planAnalyticsDeletionJobRepair({
        migrationApplied: true,
        baseSchemaMissing: [],
        columns: [
          ...oldColumns,
          {
            name: "requires_warehouse_tombstone",
            type: "INTEGER",
            notNull: 1,
            defaultValue: "1",
            primaryKey: 0,
          },
        ],
        tableSql: canonicalAnalyticsDeletionJobSql,
      }),
    ).toBe("none");
  });

  it("stops instead of repairing an unknown table shape", () => {
    expect(() =>
      planAnalyticsDeletionJobRepair({
        migrationApplied: true,
        baseSchemaMissing: [],
        columns: oldColumns.slice(1),
        tableSql: oldAnalyticsDeletionJobSql,
      }),
    ).toThrow("unexpected deletion-job column shape");
    expect(() =>
      planAnalyticsDeletionJobRepair({
        migrationApplied: true,
        baseSchemaMissing: [analyticsBaseSchemaKeys[0]],
        columns: oldColumns,
        tableSql: oldAnalyticsDeletionJobSql,
      }),
    ).toThrow("analytics migration 0009 is missing");
  });

  it("rejects changed column metadata and check constraints", () => {
    expect(() =>
      planAnalyticsDeletionJobRepair({
        migrationApplied: true,
        baseSchemaMissing: [],
        columns: oldColumns.map((column) =>
          column.name === "requested_at" ? { ...column, notNull: 0 } : column,
        ),
        tableSql: oldAnalyticsDeletionJobSql,
      }),
    ).toThrow("unexpected deletion-job column shape");

    expect(() =>
      planAnalyticsDeletionJobRepair({
        migrationApplied: true,
        baseSchemaMissing: [],
        columns: oldColumns,
        tableSql: oldAnalyticsDeletionJobSql.replace(
          "CHECK (requested_at > 0)",
          "CHECK (requested_at >= 0)",
        ),
      }),
    ).toThrow("unexpected older deletion-job definition");
  });
});
