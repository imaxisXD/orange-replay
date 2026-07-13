#!/usr/bin/env node
import process from "node:process";
import {
  INVENTORY_TOKEN_ENV,
  parseInventoryArguments,
  runR2Inventory,
} from "./analytics/r2-inventory-lib.mjs";

const helpText = `Usage: node scripts/inventory-r2.mjs [options]

Required:
  --account-id <id>    Cloudflare account ID (or CLOUDFLARE_ACCOUNT_ID)
  --bucket <name>      One replay R2 bucket (or ORANGE_REPLAY_RECORDINGS_BUCKET)

Optional:
  --report <file>      New private JSON report path
  --offline            Print the plan without network access or file writes
  --dry-run            Alias for --offline
  --help               Show this help

The Cloudflare account API token is accepted only through
${INVENTORY_TOKEN_ENV}. There is no token command option. The live command
verifies that token, mints a 15-minute object-read-only credential for the one
named bucket, follows every ListObjectsV2 page, and writes only sorted {key}
records to a new mode-0600 report.`;

try {
  const options = parseInventoryArguments(process.argv.slice(2));
  if (options.help) {
    console.log(helpText);
    process.exit(0);
  }
  const runtime = options.offline ? {} : { accountToken: process.env[INVENTORY_TOKEN_ENV] };
  const result = await runR2Inventory(options, runtime);
  console.log(JSON.stringify(result.mode === "offline" ? result.plan : result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "The R2 inventory failed.");
  process.exitCode = 1;
}
