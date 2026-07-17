import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
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

export async function preparePrivateOutputDirectory(trustedRoot, outputDirectory) {
  const root = path.resolve(trustedRoot);
  const directory = path.resolve(outputDirectory);
  const relativeDirectory = path.relative(root, directory);
  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDirectory)
  ) {
    throw new Error(`Private output directory must stay inside its trusted root: ${directory}`);
  }

  await requireSafeAncestorChain(root);
  await requireOwnedNonWritableDirectory(root);
  if (relativeDirectory.length === 0) return;

  let currentDirectory = root;
  for (const component of relativeDirectory.split(path.sep)) {
    currentDirectory = path.join(currentDirectory, component);
    try {
      await mkdir(currentDirectory, { mode: 0o700 });
    } catch (error) {
      if (!isExistingPathError(error)) throw error;
    }
    await requireOwnedNonWritableDirectory(currentDirectory);
  }
}

export async function preparePrivateOutputFile(trustedRoot, filePath) {
  const resolvedPath = path.resolve(filePath);
  await preparePrivateOutputDirectory(trustedRoot, path.dirname(resolvedPath));
  await requireMissingDestination(resolvedPath);
}

export async function writePrivateFileOnceAtomically(filePath, contents, trustedRoot) {
  const noFollow = requireNoFollowFlag();
  const resolvedPath = path.resolve(filePath);
  const directory = path.dirname(resolvedPath);
  await preparePrivateOutputFile(trustedRoot, resolvedPath);

  const temporaryPath = path.join(
    directory,
    `.${path.basename(resolvedPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    const openedFile = await handle.stat();
    if (!openedFile.isFile()) {
      throw new Error(`Private report temporary path is not a regular file: ${temporaryPath}`);
    }
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await preparePrivateOutputFile(trustedRoot, resolvedPath);
    await link(temporaryPath, resolvedPath);
    await syncDirectory(directory, noFollow);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function confirmPrivateFilePublication(filePath, contents, trustedRoot) {
  const noFollow = requireNoFollowFlag();
  const resolvedPath = path.resolve(filePath);
  const directory = path.dirname(resolvedPath);
  await preparePrivateOutputDirectory(trustedRoot, directory);

  let publishedContents;
  try {
    publishedContents = await readPrivateRegularFile(resolvedPath);
  } catch (error) {
    if (isMissingFileError(error)) return { durable: false, missing: true, published: false };
    throw error;
  }
  if (publishedContents !== contents) {
    return { durable: false, missing: false, published: false };
  }

  try {
    await syncDirectory(directory, noFollow);
    return { durable: true, missing: false, published: true };
  } catch (error) {
    return { durable: false, error, missing: false, published: true };
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

async function requireOwnedNonWritableDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Private output directory must not be a symbolic link: ${directory}`);
  }
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUserId !== undefined && info.uid !== currentUserId) {
    throw new Error(`Private output directory must be owned by the current user: ${directory}`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(`Private output directory must not be writable by other users: ${directory}`);
  }
}

async function requireSafeAncestorChain(directory) {
  const currentUserId = requireCurrentUserId();
  const resolvedDirectory = path.resolve(directory);
  await requireSafeAncestorPath(resolvedDirectory, currentUserId);

  const canonicalDirectory = await realpath(resolvedDirectory);
  if (canonicalDirectory !== resolvedDirectory) {
    await requireSafeAncestorPath(canonicalDirectory, currentUserId);
  }
}

async function requireSafeAncestorPath(directory, currentUserId) {
  const root = path.parse(directory).root;
  const relativeParts = path.relative(root, directory).split(path.sep).filter(Boolean);
  const paths = [root];
  let currentPath = root;
  for (const part of relativeParts) {
    currentPath = path.join(currentPath, part);
    paths.push(currentPath);
  }

  for (const ancestorPath of paths) {
    const info = await lstat(ancestorPath);
    if (!info.isDirectory() && !info.isSymbolicLink()) {
      throw new Error(`Private output has a non-directory ancestor: ${ancestorPath}`);
    }
    if (info.uid !== currentUserId && info.uid !== 0) {
      throw new Error(`Private output has an unsafe owner in its ancestor path: ${ancestorPath}`);
    }
    if (info.isDirectory() && (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) {
      throw new Error(`Private output has an unsafe writable ancestor: ${ancestorPath}`);
    }
  }
}

function requireCurrentUserId() {
  if (typeof process.getuid !== "function") {
    throw new Error("Private report writing requires operating-system ownership checks.");
  }
  return process.getuid();
}

async function requireMissingDestination(filePath) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  throw new Error(`Private report already exists and will not be overwritten: ${filePath}`);
}

function requireNoFollowFlag() {
  if (constants.O_NOFOLLOW === undefined) {
    throw new Error("Private report writing requires symbolic-link protection on this platform.");
  }
  return constants.O_NOFOLLOW;
}

async function syncDirectory(directory, noFollow) {
  const directoryOnly = constants.O_DIRECTORY ?? 0;
  const handle = await open(directory, constants.O_RDONLY | directoryOnly | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      throw new Error(`Private output directory is not a directory: ${directory}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
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

function isExistingPathError(error) {
  return error !== null && typeof error === "object" && error.code === "EEXIST";
}
