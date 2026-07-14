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
  const userRows = queryRows(
    `SELECT id, email FROM users WHERE lower(email) = lower(${sqlText(options.email)})`,
    options,
  );
  if (userRows.length === 0) {
    throw new Error("No signed-in user has that email. Sign in with GitHub once, then retry.");
  }
  if (userRows.length !== 1) {
    throw new Error("More than one user has that email. Stop and inspect the users table.");
  }

  const user = userRows[0];
  if (typeof user?.id !== "string") {
    throw new Error("The matching user row is invalid.");
  }

  const workspaceRows = queryRows(
    `SELECT id, name FROM orgs WHERE id = ${sqlText(options.workspaceId)}`,
    options,
  );
  if (workspaceRows.length !== 1) {
    throw new Error("The workspace ID was not found. No membership was changed.");
  }

  const ownerRows = queryRows(
    `SELECT user_id FROM members WHERE org_id = ${sqlText(options.workspaceId)} AND (role = 'owner' OR ',' || role || ',' LIKE '%,owner,%')`,
    options,
  );
  const otherOwner = ownerRows.find((row) => row?.user_id !== user.id);
  if (otherOwner !== undefined) {
    throw new Error("This workspace already has a different owner. No membership was changed.");
  }

  const membershipRows = queryRows(
    `SELECT id, role FROM members WHERE org_id = ${sqlText(options.workspaceId)} AND user_id = ${sqlText(user.id)}`,
    options,
  );
  if (membershipRows.length > 1) {
    throw new Error("This user has duplicate workspace memberships. Stop and repair them first.");
  }
  if (membershipRows[0]?.role === "owner") {
    console.log(`Workspace ${options.workspaceId} is already linked to ${options.email} as owner.`);
    return;
  }

  const now = Date.now();
  const command =
    membershipRows.length === 1
      ? `UPDATE members SET role = 'owner' WHERE org_id = ${sqlText(options.workspaceId)} AND user_id = ${sqlText(user.id)}`
      : `INSERT INTO members (id, org_id, user_id, role, created_at) VALUES (${sqlText(`member_${randomUUID().replaceAll("-", "")}`)}, ${sqlText(options.workspaceId)}, ${sqlText(user.id)}, 'owner', ${now})`;

  runWrangler([...databaseArgs(options), "--command", command]);
  console.log(`Linked workspace ${options.workspaceId} to ${options.email} as owner.`);
}

function queryRows(sql, options) {
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
