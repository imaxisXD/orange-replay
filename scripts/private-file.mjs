import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export async function readPrivateRegularFile(filePath, encoding = "utf8") {
  await requireRegularFile(filePath, "read");
  const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Private file must be a regular file: ${filePath}`);
    return await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
}

export async function writePrivateFileAtomically(filePath, contents) {
  const directory = path.dirname(filePath);
  await requireRegularDirectory(directory);
  await requireSafeDestination(filePath);

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // A rename replaces a destination link rather than following it, but
    // rejecting one also exposes a planted-link attempt to the operator.
    await requireSafeDestination(filePath);
    await rename(temporaryPath, filePath);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function requireRegularFile(filePath, operation) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Private file is not safe to ${operation}: ${filePath}`);
  }
}

async function requireRegularDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Private file directory is not safe: ${directory}`);
  }
}

async function requireSafeDestination(filePath) {
  try {
    await requireRegularFile(filePath, "replace");
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

function isMissingFileError(error) {
  return error !== null && typeof error === "object" && error.code === "ENOENT";
}
