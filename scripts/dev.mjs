import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps", "worker");
const dashboardDir = path.join(repoRoot, "apps", "dashboard");
const defaultWorkerPort = 8787;
const defaultDashboardPort = 5200;

const workerPort = readPort("WORKER_PORT", defaultWorkerPort);
const dashboardPort = readPort("DASHBOARD_PORT", defaultDashboardPort);
const shouldClearPorts = process.env["CLEAR_DEV_PORTS"] === "1";
const canClearCustomPorts = process.env["CLEAR_CUSTOM_DEV_PORTS"] === "1";

const runningServers = new Map();
let stopping = false;

console.log("Applying pending local D1 migrations.");
const migrationResult = await runQuietly(process.execPath, [
  path.join(repoRoot, "scripts", "apply-d1-migrations.mjs"),
  "orange-replay-idx-00",
  "--local",
]);
if (!migrationResult.ok) {
  console.error("Local D1 migrations could not be applied.");
  if (migrationResult.stderr.trim().length > 0) console.error(migrationResult.stderr.trim());
  process.exit(1);
}
if (migrationResult.stdout.trim().length > 0) console.log(migrationResult.stdout.trim());

if (shouldClearPorts) {
  if (
    !canClearCustomPorts &&
    (workerPort !== defaultWorkerPort || dashboardPort !== defaultDashboardPort)
  ) {
    console.error("CLEAR_CUSTOM_DEV_PORTS=1 is required when clearing custom dev ports.");
    process.exit(1);
  }
  console.log("CLEAR_DEV_PORTS=1 set. Stopping existing listeners on dev ports.");
  await clearPort(workerPort);
  await clearPort(dashboardPort);
}

const workerArgs = [
  "exec",
  "--filter",
  "@orange-replay/worker",
  "--",
  "wrangler",
  "dev",
  "--port",
  String(workerPort),
];

const localWorkerEnv = path.join(workerDir, ".env");
const exampleWorkerEnv = path.join(workerDir, ".env.example");
if (!existsSync(localWorkerEnv) && existsSync(exampleWorkerEnv)) {
  workerArgs.push("--env-file", ".env.example");
  console.log("Using apps/worker/.env.example for local Worker secrets.");
}

startServer("worker", "vp", workerArgs, repoRoot, process.env);

startServer("dashboard", "vp", ["dev", "--port", String(dashboardPort)], dashboardDir, {
  ...process.env,
  VITE_WORKER_URL: process.env["VITE_WORKER_URL"] ?? `http://127.0.0.1:${workerPort}`,
});

console.log(`Worker: http://localhost:${workerPort}`);
console.log(`Dashboard: http://localhost:${dashboardPort}`);
console.log("Press Ctrl+C to stop both servers.");

process.on("SIGINT", () => stopServers("SIGINT"));
process.on("SIGTERM", () => stopServers("SIGTERM"));

function readPort(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") return fallback;

  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`${name} must be a number from 1 to 65535.`);
    process.exit(1);
  }

  return port;
}

async function clearPort(port) {
  const pids = await findPortPids(port);
  if (pids.length === 0) {
    console.log(`Port ${port} is free.`);
    return;
  }

  console.log(`Stopping port ${port}: ${pids.join(", ")}`);
  await runQuietly("kill", ["-TERM", ...pids]);
  await wait(900);

  const remainingPids = await findPortPids(port);
  if (remainingPids.length > 0) {
    console.error(`Port ${port} is still in use by ${remainingPids.join(", ")}.`);
    process.exit(1);
  }
}

async function findPortPids(port) {
  const result = await runQuietly("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"]);
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((pid, index, list) => list.indexOf(pid) === index);
}

function runQuietly(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: repoRoot }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

function startServer(name, command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: ["inherit", "pipe", "pipe"] });
  const outputBuffers = { stdout: "", stderr: "" };
  runningServers.set(name, child);

  child.stdout?.on("data", (chunk) =>
    writeLines(name, chunk, process.stdout, outputBuffers, "stdout"),
  );
  child.stderr?.on("data", (chunk) =>
    writeLines(name, chunk, process.stderr, outputBuffers, "stderr"),
  );
  child.stdout?.on("end", () => flushLine(name, process.stdout, outputBuffers, "stdout"));
  child.stderr?.on("end", () => flushLine(name, process.stderr, outputBuffers, "stderr"));

  child.on("error", (error) => {
    runningServers.delete(name);
    console.error(`${name} could not start: ${error.message}`);
    process.exitCode = 1;
    stopServers("spawn_error");
  });

  child.on("exit", (code, signal) => {
    flushLine(name, process.stdout, outputBuffers, "stdout");
    flushLine(name, process.stderr, outputBuffers, "stderr");
    runningServers.delete(name);
    if (stopping) return;

    const reason = signal ?? code ?? "unknown";
    console.error(`${name} stopped early (${reason}).`);
    stopServers("child_exit");
    process.exitCode = typeof code === "number" && code !== 0 ? code : 1;
  });
}

function writeLines(name, chunk, stream, buffers, key) {
  const text = `${buffers[key]}${chunk.toString()}`;
  const lines = text.split(/\r?\n/);
  buffers[key] = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length > 0) stream.write(`[${name}] ${line}\n`);
  }
}

function flushLine(name, stream, buffers, key) {
  if (buffers[key].length === 0) {
    return;
  }

  stream.write(`[${name}] ${buffers[key]}\n`);
  buffers[key] = "";
}

function stopServers(reason) {
  if (stopping) return;
  stopping = true;

  console.log(`Stopping dev servers (${reason}).`);
  for (const child of runningServers.values()) {
    child.kill("SIGTERM");
  }

  setTimeout(() => {
    for (const child of runningServers.values()) {
      child.kill("SIGKILL");
    }
    process.exit();
  }, 1200).unref();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
