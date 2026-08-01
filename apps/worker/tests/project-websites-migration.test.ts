import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

describe("project Websites migration", () => {
  it("adds Website identity, one active key per Website, and the shared session domain", async () => {
    const migration = await readFile(
      new URL("../migrations/0023_project_websites.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("ALTER TABLE projects ADD COLUMN session_cookie_domain TEXT");
    expect(migration).toContain("CREATE TABLE project_websites");
    expect(migration).toContain("CREATE UNIQUE INDEX idx_project_websites_origin");
    expect(migration).toContain("ALTER TABLE keys ADD COLUMN website_id TEXT");
    expect(migration).toContain("CREATE UNIQUE INDEX idx_keys_one_active_website_key");
    expect(migration).toContain("WHERE website_id IS NOT NULL AND active = 1");
  });

  it("keeps the self-host migration byte-for-byte identical", async () => {
    const canonical = await readFile(
      new URL("../migrations/0023_project_websites.sql", import.meta.url),
      "utf8",
    );
    const selfHosted = await readFile(
      new URL("../../../infra/template/migrations/0023_project_websites.sql", import.meta.url),
      "utf8",
    );
    expect(selfHosted).toBe(canonical);
  });
});
