#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const options = readOptions(process.argv.slice(2));
  const users = queryUsers(options);
  if (users.length === 0) {
    throw new Error("No signed-in user has that email. Sign in with GitHub once, then retry.");
  }
  if (users.length !== 1 || typeof users[0]?.id !== "string") {
    throw new Error("The email did not match exactly one valid user. No role was changed.");
  }
  if (users[0].role === "admin") {
    console.log(`${options.email} is already an Orange Replay operator.`);
    process.exit(0);
  }

  runWrangler(
    [
      ...databaseArgs(options),
      "--command",
      `UPDATE users SET role = 'admin', updated_at = ${Date.now()} WHERE id = ${sqlText(users[0].id)}`,
    ],
    "inherit",
  );
  console.log(`Promoted ${options.email} to Orange Replay operator.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function queryUsers(options) {
  const output = runWrangler(
    [
      ...databaseArgs(options),
      "--command",
      `SELECT id, email, role FROM users WHERE lower(email) = lower(${sqlText(options.email)})`,
      "--json",
    ],
    "capture",
  );
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

function runWrangler(args, outputMode) {
  const output = execFileSync(
    "vp",
    ["exec", "--filter", "@orange-replay/worker", "--", "wrangler", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: outputMode === "capture" ? ["ignore", "pipe", "inherit"] : "inherit",
    },
  );
  return typeof output === "string" ? output : "";
}

function readOptions(args) {
  const parsed = {
    email: undefined,
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
  vp run auth:promote-admin -- --email you@example.com --local
  vp run auth:promote-admin -- --config apps/worker/wrangler.cloudflare-build.jsonc --email you@example.com --remote

The user must sign in with GitHub once before this script can find them.
Choose --local or --remote explicitly. Remote uses the production Wrangler environment by default.
Hosted production should use the generated Wrangler config with the real resource ids.`);
}
