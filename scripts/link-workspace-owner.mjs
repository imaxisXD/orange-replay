#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let options;
try {
  options = readOptions(process.argv.slice(2));
  linkOwner(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function linkOwner(options) {
  const now = Date.now();
  const memberId = `member_${randomUUID().replaceAll("-", "")}`;
  const command = `WITH matching_users AS (
    SELECT id FROM users WHERE lower(email) = lower(${sqlText(options.email)})
  )
  INSERT INTO members (id, org_id, user_id, role, created_at)
  SELECT ${sqlText(memberId)}, orgs.id, matching_users.id, 'owner', ${now}
  FROM orgs
  CROSS JOIN matching_users
  WHERE orgs.id = ${sqlText(options.workspaceId)}
    AND (SELECT COUNT(*) FROM matching_users) = 1
    AND NOT EXISTS (
      SELECT 1 FROM members existing_owner
      WHERE existing_owner.org_id = orgs.id
        AND existing_owner.user_id <> matching_users.id
        AND (
          existing_owner.role = 'owner'
          OR ',' || existing_owner.role || ',' LIKE '%,owner,%'
        )
    )
  ON CONFLICT(org_id, user_id) DO UPDATE SET role = 'owner'
  WHERE NOT EXISTS (
    SELECT 1 FROM members existing_owner
    WHERE existing_owner.org_id = excluded.org_id
      AND existing_owner.user_id <> excluded.user_id
      AND (
        existing_owner.role = 'owner'
        OR ',' || existing_owner.role || ',' LIKE '%,owner,%'
      )
  )
  RETURNING id, org_id, user_id, role`;
  const changedRows = sqlRows(command, options);
  if (changedRows.length !== 1 || changedRows[0]?.role !== "owner") {
    throw new Error(
      "No membership was changed. Check that the user signed in once, the workspace exists, and no different owner is linked.",
    );
  }
  console.log(`Linked workspace ${options.workspaceId} to ${options.email} as owner.`);
}

function sqlRows(sql, options) {
  const output = runWrangler([...databaseArgs(options), "--command", sql, "--json"], "capture");
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("Wrangler returned an unreadable D1 response.", { cause: error });
  }

  const rows = parsed?.[0]?.results;
  if (!Array.isArray(parsed) || parsed[0]?.success !== true || !Array.isArray(rows)) {
    throw new Error("Wrangler returned an invalid D1 response.");
  }
  return rows;
}

function databaseArgs(options) {
  const args = ["d1", "execute", "IDX_00", "--config", options.config];
  if (options.environment !== undefined) args.push("--env", options.environment);
  args.push(options.location, "--yes");
  return args;
}

function runWrangler(args, outputMode = "inherit") {
  const stdio = outputMode === "capture" ? ["ignore", "pipe", "inherit"] : "inherit";
  const output = execFileSync(
    "vp",
    ["exec", "--filter", "@orange-replay/worker", "--", "wrangler", ...args],
    { cwd: repoRoot, encoding: "utf8", stdio },
  );
  return typeof output === "string" ? output : "";
}

function readOptions(args) {
  const parsed = {
    email: undefined,
    workspaceId: undefined,
    location: undefined,
    environment: undefined,
    config: path.join(repoRoot, "apps/worker/wrangler.jsonc"),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--email") {
      parsed.email = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--workspace-id") {
      parsed.workspaceId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--env") {
      parsed.environment = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--config") {
      parsed.config = path.resolve(process.cwd(), readValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--local" || arg === "--remote") {
      if (parsed.location !== undefined) {
        throw new Error("Choose only one of --local or --remote.");
      }
      parsed.location = arg;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (parsed.location === undefined) {
    throw new Error(
      "Choose --local or --remote. This script never guesses which database to change.",
    );
  }
  if (parsed.location === "--remote" && parsed.environment === undefined) {
    parsed.environment = "production";
  }
  if (parsed.email === undefined || !isEmail(parsed.email)) {
    throw new Error("--email must be the exact email from the signed-in GitHub account.");
  }
  if (parsed.workspaceId === undefined || !/^[A-Za-z0-9_-]+$/.test(parsed.workspaceId)) {
    throw new Error("--workspace-id must use only letters, numbers, _ or -.");
  }
  if (parsed.environment !== undefined && !/^[A-Za-z0-9_-]+$/.test(parsed.environment)) {
    throw new Error("--env must be a simple Wrangler environment name.");
  }
  return parsed;
}

function readValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} needs a value.`);
  }
  return value.trim();
}

function isEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function printHelp() {
  console.log(`Usage:
  vp run workspace:link-owner -- --email you@example.com --workspace-id WORKSPACE --local
  vp run workspace:link-owner -- --config apps/worker/wrangler.cloudflare-build.jsonc --email you@example.com --workspace-id WORKSPACE --remote

The user must sign in with GitHub once before this script can find them.
Choose --local or --remote explicitly. Remote uses the production Wrangler environment by default.
Hosted production should use the generated Wrangler config with the real resource ids.`);
}
