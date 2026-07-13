import { readFile } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type PurgeSqlValue = string | number | bigint | Uint8Array | null;

export interface PurgeD1Result {
  meta: { changes: number };
}

export class PurgeTestDatabase {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(query: string): PurgeTestStatement {
    return new PurgeTestStatement(this.sqlite.prepare(query));
  }

  async batch(statements: readonly PurgeTestStatement[]): Promise<readonly PurgeD1Result[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.runNow());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  run(query: string, ...values: PurgeSqlValue[]): void {
    this.sqlite.prepare(query).run(...values);
  }

  row(query: string, ...values: PurgeSqlValue[]): Record<string, unknown> | undefined {
    return this.sqlite.prepare(query).get(...values);
  }

  value(query: string, ...values: PurgeSqlValue[]): unknown {
    return Object.values(this.row(query, ...values) ?? {})[0];
  }

  close(): void {
    this.sqlite.close();
  }
}

export class PurgeTestStatement {
  private values: PurgeSqlValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: PurgeSqlValue[]): PurgeTestStatement {
    this.values = values;
    return this;
  }

  async all<Row extends Record<string, unknown>>(): Promise<{ results: Row[] }> {
    return { results: this.statement.all(...this.values) as Row[] };
  }

  async first<Row extends Record<string, unknown>>(): Promise<Row | null> {
    return (this.statement.get(...this.values) as Row | undefined) ?? null;
  }

  async run(): Promise<PurgeD1Result> {
    return this.runNow();
  }

  runNow(): PurgeD1Result {
    const result = this.statement.run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

export async function createPurgeTestDatabase(): Promise<PurgeTestDatabase> {
  const database = new PurgeTestDatabase();
  database.sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, jurisdiction TEXT)");
  const migration = await readFile(
    new URL("../migrations/0009_analytics_warehouse.sql", import.meta.url),
    "utf8",
  );
  database.sqlite.exec(migration);
  return database;
}
