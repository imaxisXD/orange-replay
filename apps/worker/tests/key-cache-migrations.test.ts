import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

describe("key cache upgrade migrations", () => {
  it("queues both active and revoked existing keys for one safe refresh", async () => {
    for (const name of ["0013_key_cache_final_check.sql", "0014_key_cache_write_jobs.sql"]) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      expect(sql).toContain("UPDATE keys SET cache_synced = 0, cache_final_check_at = 0;");
    }
  });
});
