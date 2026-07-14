# D1 migration recovery

Always run Orange Replay migrations through the repo wrapper:

```sh
vp run db:migrate:local
```

For production, use the reviewed deploy command. Do not rename an applied migration, edit `d1_migrations` by hand, or delete local Wrangler state to make an error disappear.

## Known local filename repair

Some local databases applied the hosted-auth migrations while those files still used older numbers. The wrapper recognizes only the two known histories, proves that every recorded table, column, and index exists, then changes the local migration names to the canonical `0011` through `0015` names. It also repairs the exact known older local `0009_analytics_warehouse.sql` table shape. Remote migration history is never rewritten.

If the wrapper reports an ambiguous or incomplete history, stop and restore or inspect a backup. It deliberately will not guess.

## Legacy project-scoped 0001 repair

Before migration `0005_repair_project_scoped_schema.sql`, one short-lived schema allowed the same session ID in more than one project while sparse `session_events` rows lacked enough identity to assign those events safely. The wrapper installs temporary write guards and stops if such rows still exist.

Back up the database. Then remove only sparse events for ambiguous session IDs:

```sql
DELETE FROM session_events
WHERE session_id IN (
  SELECT session_id
  FROM sessions
  GROUP BY session_id
  HAVING COUNT(DISTINCT project_id) > 1
);
```

Keep every `sessions` row and every replay object. Run the wrapper again; migrations `0005` through `0008` complete the repair and remove the temporary guards.
