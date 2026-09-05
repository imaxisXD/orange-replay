import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { readSchema } from "./d1-schema-shape.mjs";

describe("D1 schema comparison", () => {
  it("compares added columns by name and accepts equivalent boolean defaults", () => {
    expect(
      schema(`CREATE TABLE sample (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
        ALTER TABLE sample ADD COLUMN detail TEXT;`),
    ).toEqual(
      schema(`CREATE TABLE sample (id TEXT PRIMARY KEY, detail TEXT,
        enabled INTEGER NOT NULL DEFAULT true);`),
    );
  });

  it.each([
    ["default", "value INTEGER DEFAULT 30", "value INTEGER DEFAULT 90"],
    ["text default", "value INTEGER DEFAULT true", "value INTEGER DEFAULT 'true'"],
    ["nullability", "value INTEGER", "value INTEGER NOT NULL"],
    ["column type", "value INTEGER", "value TEXT"],
  ])("still detects a changed %s", (_name, first, second) => {
    expect(schema(`CREATE TABLE sample (${first})`)).not.toEqual(
      schema(`CREATE TABLE sample (${second})`),
    );
  });

  it("preserves composite primary key and index order", () => {
    const create = "CREATE TABLE sample (a TEXT, b TEXT, PRIMARY KEY (a, b));";
    expect(schema(create)).not.toEqual(
      schema("CREATE TABLE sample (a TEXT, b TEXT, PRIMARY KEY (b, a));"),
    );
    expect(schema(`${create} CREATE INDEX ordered ON sample (a, b)`)).not.toEqual(
      schema(`${create} CREATE INDEX ordered ON sample (b, a)`),
    );
  });
});

function schema(sql) {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(sql);
    return readSchema(database);
  } finally {
    database.close();
  }
}
