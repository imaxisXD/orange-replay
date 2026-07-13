import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { buildNewProjectAnalyticsReceiptSql } from "./analytics/project-bootstrap.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDirectory, "..");
const fixedWriteKey = `or_live_${"a".repeat(32)}`;

describe("new project analytics receipt", () => {
  it("builds a zero-source receipt only when the project insert changed a row", () => {
    const sql = buildNewProjectAnalyticsReceiptSql({
      projectId: "project_can't_mix",
      createdAt: 1_700_000_000_000,
      reportId: "new-project-bootstrap:test",
    });

    expect(sql).toContain("INSERT INTO analytics_backfill_completions");
    expect(sql).toContain("'project_can''t_mix'");
    expect(sql).toContain("source_session_count");
    expect(sql).toContain("required_sequence");
    expect(sql).toContain("SELECT 'project_can''t_mix', 0, 1700000000000, 0");
    expect(sql).toContain("WHERE changes() = 1");
  });

  it.each([
    {
      file: "bootstrap-demo-project.mjs",
      projectId: "demo_script_project",
      reportId: "new-project-bootstrap:demo-script",
      args: [
        "--origin",
        "https://demo.example.com",
        "--project-id",
        "demo_script_project",
        "--org-id",
        "demo_script_org",
      ],
    },
    {
      file: "bootstrap-prod-project.mjs",
      projectId: "production_script_project",
      reportId: "new-project-bootstrap:production-script",
      args: [
        "--origin",
        "https://app.example.com",
        "--project-id",
        "production_script_project",
        "--org-id",
        "production_script_org",
      ],
    },
  ])(
    "puts the receipt directly after the project insert in $file",
    ({ file, projectId, args, reportId }) => {
      const output = execFileSync(
        process.execPath,
        [path.join(scriptsDirectory, file), "--dry-run", "--key", fixedWriteKey, ...args],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            ORANGE_REPLAY_PROD_API_PROJECT_IDS: "production_script_project",
          },
        },
      );

      const projectInsertAt = output.indexOf("INSERT INTO projects");
      const receiptInsertAt = output.indexOf("INSERT INTO analytics_backfill_completions");
      const keyInsertAt = output.indexOf("INSERT INTO keys");
      expect(projectInsertAt).toBeGreaterThan(-1);
      expect(receiptInsertAt).toBeGreaterThan(projectInsertAt);
      expect(keyInsertAt).toBeGreaterThan(receiptInsertAt);
      expect(output).toContain(`'${projectId}'`);
      expect(output).toContain(`'${reportId}'`);
      expect(output).toContain("WHERE changes() = 1");
    },
  );
});
