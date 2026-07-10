# D1 schema and migration workflow

Read this before changing any D1 table, column, index, or migration.

## Tool ownership

| Part                           | Owner       | Purpose                                               |
| ------------------------------ | ----------- | ----------------------------------------------------- |
| `apps/worker/src/db/schema.ts` | Drizzle     | The intended current D1 schema and indexes            |
| `apps/worker/drizzle/`         | Drizzle Kit | Schema snapshots and generated authoring history      |
| `apps/worker/migrations/`      | Wrangler    | The only SQL files applied to local and production D1 |
| D1 table `d1_migrations`       | Wrangler    | The only applied-migration history used in production |

Drizzle helps create and check schema changes. Wrangler still applies them. Do not run `drizzle-kit push`, `drizzle-kit migrate`, or Drizzle's runtime migrator against any Orange Replay database. They would create a second migration history and bypass the deployment safety gate.

The `existing_schema_baseline` directory under `apps/worker/drizzle/` describes the schema after the existing numbered migrations. It is authoring metadata only. Never copy or apply that baseline to production.

The Drizzle packages are pinned to `1.0.0-rc.4` as development-only tools because the current official D1 guide uses the RC line. At adoption time, the older stable Drizzle Kit pulled an `esbuild` version affected by [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99). Do not change these versions without checking the current Drizzle D1 guide, running `pnpm audit`, regenerating a disposable migration, and rerunning every check in this document.

## Create a schema change

1. Update `apps/worker/src/db/schema.ts` first.
2. Generate both the Drizzle snapshot and the next numbered Wrangler migration:

   ```sh
   vp run db:generate -- add_example_column
   ```

3. Review the new file in `apps/worker/migrations/`. Generated SQL is a starting point, not approval. Check table rebuilds, dropped columns, new `NOT NULL` columns, default values, indexes, and preservation of existing rows. Add explicit copy or backfill SQL when needed.
4. Check that the full numbered migration history produces the same schema as Drizzle:

   ```sh
   vp run db:check
   ```

5. Apply every pending migration to the normal local D1 database:

   ```sh
   vp run db:migrate:local
   ```

6. Run the normal gates and template check:

   ```sh
   vp check
   vp test
   node scripts/mirror-template.mjs --check
   ```

`vp run dev` applies pending local migrations before starting the Worker and dashboard. If migration application fails, development stops before either server starts.

## Production behavior

Cloudflare Workers Builds keeps using the stable command:

```sh
vp run deploy:cloudflare-build
```

That command prepares the private Wrangler config, runs `wrangler d1 migrations apply` against the stable production database name, and deploys Worker code only after every migration succeeds. Adding another numbered migration does not require a Cloudflare dashboard change.

## Legacy project-scoped 0001 repair

The short-lived edited form of `0001_init.sql` allowed the same session id in more than one project. Migration `0005_repair_project_scoped_schema.sql` was already applied to production and must not be edited, but that migration cannot safely assign old sparse `session_events` when such a collision exists.

All repo migration commands now run `scripts/apply-d1-migrations.mjs`. If `0005` is pending, the wrapper creates temporary database guards, records session ids used by more than one project, and blocks new ownership changes during the check-to-migration window. It stops before applying migrations only when one of those ids still has sparse event rows. Take a D1 backup, then remove only those ambiguous sparse event-index rows:

```sql
DELETE FROM session_events
WHERE session_id IN (
  SELECT session_id
  FROM sessions
  GROUP BY session_id
  HAVING COUNT(DISTINCT project_id) > 1
);
```

Do not delete the matching `sessions` rows or R2 replay objects. Retry the normal migration command after the sparse rows are removed. If the check stops or migration application fails, the temporary guards remain active and fail closed until the migration completes. Migration `0005` drops the guarded old tables and triggers, `0007_remove_ambiguous_session_events.sql` removes ambiguous or orphaned sparse rows for databases where `0005` had already completed, and `0008_remove_migration_guards.sql` removes the temporary guard table. Affected filters may temporarily lose those sparse events, but one project's event details cannot be shown under another project.

## Rules for agents

- Never edit or rename a numbered migration that may have been applied anywhere. Add the next migration.
- Use `scripts/apply-d1-migrations.mjs` for repo-managed D1 upgrades so the legacy tenant-collision check runs before `0005`.
- Never point Drizzle at production credentials. `drizzle.config.ts` intentionally has no database connection.
- Never use `drizzle-kit push` or `drizzle-kit migrate` in this repo.
- Keep Wrangler as the only migration runner and `d1_migrations` as the only production history table.
- Keep complex runtime and analytics queries as prepared D1 SQL unless a separate task explicitly moves them.
- Commit the Drizzle snapshot directory and its matching numbered Wrangler migration together.
- Mirror migration changes into `infra/template` using `node scripts/mirror-template.mjs`; do not edit the mirrored copy by hand.
- For a data-moving migration, test both a fresh database and an existing database with representative rows before production.
