import { createHash, createHmac } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

export const INVENTORY_TOKEN_ENV = "ORANGE_REPLAY_R2_INVENTORY_TOKEN";
export const TEMPORARY_CREDENTIAL_TTL_SECONDS = 900;

const cloudflareApiOrigin = "https://api.cloudflare.com/client/v4";
const emptyPayloadHash = createHash("sha256").update("").digest("hex");
const maximumApiResponseBytes = 64 * 1024;
const maximumListResponseBytes = 16 * 1024 * 1024;
const maximumListPages = 100_000;
const accountIdPattern = /^[a-f0-9]{32}$/i;
const bucketNamePattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

class SafeInventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "SafeInventoryError";
  }
}

export function parseInventoryArguments(
  argumentsList,
  { cwd = process.cwd(), env = process.env, now = new Date() } = {},
) {
  const options = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    bucket: env.ORANGE_REPLAY_RECORDINGS_BUCKET,
    offline: false,
    reportPath: defaultInventoryReportPath(cwd, now),
  };
  const seen = new Set();

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--offline" || argument === "--dry-run") {
      options.offline = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--account-id") {
      options.accountId = readOneArgument(argumentsList, index, argument, seen);
      index += 1;
      continue;
    }
    if (argument === "--bucket") {
      options.bucket = readOneArgument(argumentsList, index, argument, seen);
      index += 1;
      continue;
    }
    if (argument === "--report") {
      options.reportPath = path.resolve(cwd, readOneArgument(argumentsList, index, argument, seen));
      index += 1;
      continue;
    }
    throw new SafeInventoryError(`Unknown inventory option: ${argument}`);
  }

  if (options.help) return options;
  return validateInventoryOptions(options);
}

export function defaultInventoryReportPath(cwd, now = new Date()) {
  const checkedNow = requireDate(now);
  const timestamp = checkedNow.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return path.join(
    cwd,
    "audits",
    "analytics-backfill",
    `production-r2-inventory-${timestamp}.json`,
  );
}

export function buildOfflineInventoryPlan(options) {
  const checked = validateInventoryOptions({ ...options, offline: true });
  return {
    event: "analytics.r2_inventory.plan",
    mode: "offline",
    networkRequests: 0,
    fileWrites: 0,
    bucket: checked.bucket,
    reportPath: checked.reportPath,
    tokenEnvironmentVariable: INVENTORY_TOKEN_ENV,
    steps: [
      { action: "verify_account_token" },
      {
        action: "mint_temporary_credentials",
        bucket: checked.bucket,
        permission: "object-read-only",
        ttlSeconds: TEMPORARY_CREDENTIAL_TTL_SECONDS,
      },
      { action: "list_every_object", api: "ListObjectsV2" },
      { action: "write_private_key_inventory", mode: "0600" },
    ],
  };
}

export async function runR2Inventory(
  options,
  {
    accountToken,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    requestTimeoutMs = 30_000,
    writeReport = writePrivateInventoryReport,
  } = {},
) {
  const checked = validateInventoryOptions(options);
  if (checked.offline) {
    return { mode: "offline", plan: buildOfflineInventoryPlan(checked) };
  }

  requireAccountToken(accountToken);
  if (typeof fetchImpl !== "function") {
    throw new SafeInventoryError("This Node runtime does not provide fetch.");
  }
  if (typeof writeReport !== "function") {
    throw new SafeInventoryError("The inventory report writer is unavailable.");
  }

  const parentAccessKeyId = await verifyAccountToken({
    accountId: checked.accountId,
    accountToken,
    fetchImpl,
    requestTimeoutMs,
  });
  const credentials = await mintTemporaryReadOnlyCredentials({
    accountId: checked.accountId,
    accountToken,
    bucket: checked.bucket,
    fetchImpl,
    parentAccessKeyId,
    requestTimeoutMs,
  });
  const keys = await listAllR2ObjectKeys({
    accountId: checked.accountId,
    bucket: checked.bucket,
    credentials,
    fetchImpl,
    now,
    requestTimeoutMs,
  });
  const records = toInventoryRecords(keys);
  await writeReport(checked.reportPath, records);

  return {
    bucket: checked.bucket,
    mode: "complete",
    objectCount: records.length,
    reportPath: checked.reportPath,
  };
}

export async function verifyAccountToken({
  accountId,
  accountToken,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 30_000,
}) {
  const checkedAccountId = normalizeAccountId(accountId);
  requireAccountToken(accountToken);
  const payload = await fetchJson(
    `${cloudflareApiOrigin}/accounts/${checkedAccountId}/tokens/verify`,
    {
      headers: { authorization: `Bearer ${accountToken}` },
      method: "GET",
    },
    {
      fetchImpl,
      label: "Cloudflare account-token check",
      maximumBytes: maximumApiResponseBytes,
      requestTimeoutMs,
    },
  );

  if (payload?.success !== true || payload?.result?.status !== "active") {
    throw new SafeInventoryError("The Cloudflare account token is not active.");
  }
  const parentAccessKeyId = payload.result.id;
  if (typeof parentAccessKeyId !== "string" || !accountIdPattern.test(parentAccessKeyId)) {
    throw new SafeInventoryError("Cloudflare did not return a valid parent token ID.");
  }
  return parentAccessKeyId;
}

export async function mintTemporaryReadOnlyCredentials({
  accountId,
  accountToken,
  bucket,
  fetchImpl = globalThis.fetch,
  parentAccessKeyId,
  requestTimeoutMs = 30_000,
}) {
  const checkedAccountId = normalizeAccountId(accountId);
  requireAccountToken(accountToken);
  requireBucketName(bucket);
  if (typeof parentAccessKeyId !== "string" || !accountIdPattern.test(parentAccessKeyId)) {
    throw new SafeInventoryError("The parent token ID is invalid.");
  }

  const payload = await fetchJson(
    `${cloudflareApiOrigin}/accounts/${checkedAccountId}/r2/temp-access-credentials`,
    {
      body: JSON.stringify({
        bucket,
        parentAccessKeyId,
        permission: "object-read-only",
        ttlSeconds: TEMPORARY_CREDENTIAL_TTL_SECONDS,
      }),
      headers: {
        authorization: `Bearer ${accountToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
    {
      fetchImpl,
      label: "Cloudflare temporary R2 credential request",
      maximumBytes: maximumApiResponseBytes,
      requestTimeoutMs,
    },
  );

  const result = payload?.success === true ? payload.result : undefined;
  const credentials = {
    accessKeyId: requireCredential(result?.accessKeyId),
    secretAccessKey: requireCredential(result?.secretAccessKey),
    sessionToken: requireCredential(result?.sessionToken),
  };
  if (Object.values(credentials).some((value) => value === undefined)) {
    throw new SafeInventoryError("Cloudflare did not return temporary R2 credentials.");
  }
  return credentials;
}

export function signR2ListRequest({
  accountId,
  bucket,
  continuationToken,
  credentials,
  now = new Date(),
}) {
  const checkedAccountId = normalizeAccountId(accountId);
  requireBucketName(bucket);
  const accessKeyId = requireCredential(credentials?.accessKeyId);
  const secretAccessKey = requireCredential(credentials?.secretAccessKey);
  const sessionToken = requireCredential(credentials?.sessionToken);
  if (accessKeyId === undefined || secretAccessKey === undefined || sessionToken === undefined) {
    throw new SafeInventoryError("Temporary R2 credentials are incomplete.");
  }
  if (
    continuationToken !== undefined &&
    (typeof continuationToken !== "string" ||
      continuationToken.length === 0 ||
      continuationToken.length > 16_384 ||
      continuationToken.includes("\0"))
  ) {
    throw new SafeInventoryError("The R2 continuation token is invalid.");
  }

  const checkedNow = requireDate(now);
  const amzDate = checkedNow.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = `${checkedAccountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${awsEncode(bucket)}`;
  const query = [
    ["encoding-type", "url"],
    ["list-type", "2"],
  ];
  if (continuationToken !== undefined) {
    query.push(["continuation-token", continuationToken]);
  }
  const canonicalQuery = query
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? compareText(leftValue, rightValue) : compareText(leftKey, rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const signedHeaderNames = "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${emptyPayloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${sessionToken}\n`;
  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames,
    emptyPayloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), "auto"), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    headers: {
      authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
      "x-amz-content-sha256": emptyPayloadHash,
      "x-amz-date": amzDate,
      "x-amz-security-token": sessionToken,
    },
    method: "GET",
    url: `https://${host}${canonicalUri}?${canonicalQuery}`,
  };
}

export async function listAllR2ObjectKeys({
  accountId,
  bucket,
  credentials,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  requestTimeoutMs = 30_000,
}) {
  if (typeof fetchImpl !== "function") {
    throw new SafeInventoryError("This Node runtime does not provide fetch.");
  }
  if (typeof now !== "function") {
    throw new SafeInventoryError("The inventory clock is unavailable.");
  }

  const keys = new Set();
  const usedContinuationTokens = new Set();
  let continuationToken;

  for (let page = 1; page <= maximumListPages; page += 1) {
    const request = signR2ListRequest({
      accountId,
      bucket,
      continuationToken,
      credentials,
      now: now(),
    });
    const xml = await fetchText(
      request.url,
      { headers: request.headers, method: request.method },
      {
        fetchImpl,
        label: "R2 object listing",
        maximumBytes: maximumListResponseBytes,
        requestTimeoutMs,
      },
    );
    const result = parseListObjectsXml(xml);
    for (const key of result.keys) keys.add(key);
    if (!result.isTruncated) return [...keys];

    const nextToken = result.nextContinuationToken;
    if (nextToken === undefined || usedContinuationTokens.has(nextToken)) {
      throw new SafeInventoryError("R2 object listing did not provide a new page token.");
    }
    usedContinuationTokens.add(nextToken);
    continuationToken = nextToken;
  }

  throw new SafeInventoryError("R2 object listing returned too many pages.");
}

export function parseListObjectsXml(xml) {
  if (typeof xml !== "string" || xml.length === 0 || xml.length > maximumListResponseBytes) {
    throw new SafeInventoryError("R2 object listing returned unreadable XML.");
  }

  const root = parseXmlDocument(xml);
  if (xmlLocalName(root.name) !== "ListBucketResult" || root.text.trim().length > 0) {
    throw new SafeInventoryError("R2 object listing returned unreadable XML.");
  }
  const encodingNodes = directXmlChildren(root, "EncodingType");
  if (encodingNodes.length !== 1 || readScalarXmlText(encodingNodes[0]).trim() !== "url") {
    throw new SafeInventoryError("R2 object listing did not confirm URL-encoded keys.");
  }
  const truncatedNodes = directXmlChildren(root, "IsTruncated");
  if (truncatedNodes.length !== 1) {
    throw new SafeInventoryError("R2 object listing returned unreadable XML.");
  }
  const normalizedTruncated = readScalarXmlText(truncatedNodes[0]).trim().toLowerCase();
  if (normalizedTruncated !== "true" && normalizedTruncated !== "false") {
    throw new SafeInventoryError("R2 object listing has an invalid page marker.");
  }

  const keyCountNodes = directXmlChildren(root, "KeyCount");
  if (keyCountNodes.length !== 1) {
    throw new SafeInventoryError("R2 object listing is missing its key count.");
  }
  const keyCountText = readScalarXmlText(keyCountNodes[0]).trim();
  if (!/^\d+$/.test(keyCountText)) {
    throw new SafeInventoryError("R2 object listing has an invalid key count.");
  }
  const keyCount = Number(keyCountText);
  const contentsNodes = directXmlChildren(root, "Contents");
  if (!Number.isSafeInteger(keyCount) || keyCount > 1_000 || keyCount !== contentsNodes.length) {
    throw new SafeInventoryError("R2 object listing key count does not match its object rows.");
  }

  const keys = [];
  for (const contents of contentsNodes) {
    if (contents.text.trim().length > 0) {
      throw new SafeInventoryError("R2 object listing returned unreadable XML.");
    }
    const keyNodes = directXmlChildren(contents, "Key");
    if (keyNodes.length !== 1) {
      throw new SafeInventoryError("R2 object listing has an object row without one key.");
    }
    const key = decodeUrlEncodedKey(readScalarXmlText(keyNodes[0]));
    if (key.length === 0 || key.length > 1_024 || key.includes("\0")) {
      throw new SafeInventoryError("R2 object listing contains an invalid object key.");
    }
    keys.push(key);
  }

  const isTruncated = normalizedTruncated === "true";
  const nextTokenNodes = directXmlChildren(root, "NextContinuationToken");
  if (nextTokenNodes.length > 1) {
    throw new SafeInventoryError("R2 object listing returned unreadable XML.");
  }
  const nextContinuationToken =
    nextTokenNodes.length === 0 ? undefined : readScalarXmlText(nextTokenNodes[0]);
  if (isTruncated && (nextContinuationToken === undefined || nextContinuationToken.length === 0)) {
    throw new SafeInventoryError("R2 object listing is missing its next page token.");
  }

  return { isTruncated, keys, nextContinuationToken };
}

export function toInventoryRecords(keys) {
  if (!Array.isArray(keys)) {
    throw new SafeInventoryError("The R2 inventory keys must be an array.");
  }
  const unique = new Set();
  for (const key of keys) {
    if (typeof key !== "string" || key.length === 0 || key.length > 1_024 || key.includes("\0")) {
      throw new SafeInventoryError("The R2 inventory contains an invalid object key.");
    }
    unique.add(key);
  }
  return [...unique].sort((left, right) => left.localeCompare(right)).map((key) => ({ key }));
}

export async function writePrivateInventoryReport(reportPath, records) {
  if (typeof reportPath !== "string" || reportPath.length === 0) {
    throw new SafeInventoryError("The inventory report path is invalid.");
  }
  const normalizedRecords = toInventoryRecords(
    Array.isArray(records) ? records.map((record) => record?.key) : records,
  );
  const directory = path.dirname(reportPath);
  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
  } catch {
    throw new SafeInventoryError("The private inventory report directory could not be created.");
  }

  let handle;
  try {
    handle = await open(reportPath, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(normalizedRecords, null, 2)}\n`, {
      encoding: "utf8",
    });
    await handle.sync();
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      await unlink(reportPath).catch(() => undefined);
    }
    if (error?.code === "EEXIST") {
      throw new SafeInventoryError("The inventory report already exists; choose a new path.");
    }
    throw new SafeInventoryError("The private inventory report could not be written.");
  }
  try {
    await handle.close();
  } catch {
    await unlink(reportPath).catch(() => undefined);
    throw new SafeInventoryError("The private inventory report could not be finished.");
  }
}

function validateInventoryOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new SafeInventoryError("Inventory options are missing.");
  }
  const accountId = normalizeAccountId(options.accountId);
  requireBucketName(options.bucket);
  if (typeof options.reportPath !== "string" || options.reportPath.length === 0) {
    throw new SafeInventoryError("Pass --report with a private JSON report path.");
  }
  return {
    accountId,
    bucket: options.bucket,
    offline: options.offline === true,
    reportPath: path.resolve(options.reportPath),
  };
}

function normalizeAccountId(value) {
  if (typeof value !== "string" || !accountIdPattern.test(value)) {
    throw new SafeInventoryError(
      "Set CLOUDFLARE_ACCOUNT_ID or pass --account-id with a 32-character account ID.",
    );
  }
  return value.toLowerCase();
}

function requireBucketName(value) {
  if (typeof value !== "string" || !bucketNamePattern.test(value)) {
    throw new SafeInventoryError(
      "Set ORANGE_REPLAY_RECORDINGS_BUCKET or pass --bucket with one valid R2 bucket name.",
    );
  }
}

function requireAccountToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 10_000 ||
    value.includes("\0") ||
    /\s/.test(value)
  ) {
    throw new SafeInventoryError(`Set ${INVENTORY_TOKEN_ENV} with an account API token.`);
  }
}

function requireCredential(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384 ||
    value.includes("\0") ||
    /\s/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function requireDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SafeInventoryError("The inventory time is invalid.");
  }
  return value;
}

function readOneArgument(argumentsList, index, name, seen) {
  if (seen.has(name)) {
    throw new SafeInventoryError(`${name} can be provided only once.`);
  }
  seen.add(name);
  const value = argumentsList[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new SafeInventoryError(`${name} needs a value.`);
  }
  return value;
}

async function fetchJson(url, init, options) {
  const text = await fetchText(url, init, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new SafeInventoryError(`${options.label} returned unreadable JSON.`);
  }
}

async function fetchText(url, init, { fetchImpl, label, maximumBytes, requestTimeoutMs }) {
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 120_000
  ) {
    throw new SafeInventoryError("The inventory request timeout is invalid.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    if (response === null || typeof response !== "object" || typeof response.text !== "function") {
      throw new SafeInventoryError(`${label} returned an unreadable response.`);
    }
    if (response.ok !== true) {
      const status = Number.isSafeInteger(response.status) ? response.status : "an error";
      throw new SafeInventoryError(`${label} returned HTTP ${status}.`);
    }
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new SafeInventoryError(`${label} returned too much data.`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      throw new SafeInventoryError(`${label} returned too much data.`);
    }
    return text;
  } catch (error) {
    if (error instanceof SafeInventoryError) throw error;
    if (controller.signal.aborted) {
      throw new SafeInventoryError(`${label} took too long.`);
    }
    throw new SafeInventoryError(`${label} could not be reached.`);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeXmlText(value) {
  assertXmlCharacters(value);
  if (/<!\[CDATA\[|<[^>]*>/.test(value)) {
    throw new SafeInventoryError("R2 object listing returned unreadable XML.");
  }
  let invalidEntity = false;
  const unknownEntityCheck = value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|quot);/gi, "");
  if (unknownEntityCheck.includes("&")) {
    throw new SafeInventoryError("R2 object listing returned unreadable XML.");
  }
  const decoded = value.replace(
    /&(#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|quot);/gi,
    (whole, entity) => {
      const lowered = entity.toLowerCase();
      if (lowered === "amp") return "&";
      if (lowered === "apos") return "'";
      if (lowered === "gt") return ">";
      if (lowered === "lt") return "<";
      if (lowered === "quot") return '"';
      const codePoint = lowered.startsWith("#x")
        ? Number.parseInt(lowered.slice(2), 16)
        : Number.parseInt(lowered.slice(1), 10);
      if (!Number.isSafeInteger(codePoint) || !isValidXmlCodePoint(codePoint)) {
        invalidEntity = true;
        return "";
      }
      return String.fromCodePoint(codePoint);
    },
  );
  if (invalidEntity) {
    throw new SafeInventoryError("R2 object listing returned unreadable XML.");
  }
  return decoded;
}

function parseXmlDocument(xml) {
  let index = 0;
  let nodeCount = 0;

  if (xml.charCodeAt(0) === 0xfeff) index += 1;
  skipXmlWhitespace();
  if (xml.startsWith("<?xml", index)) {
    const declarationEnd = xml.indexOf("?>", index + 5);
    if (declarationEnd < 0) failXml();
    const declaration = xml.slice(index, declarationEnd + 2);
    if (
      !/^<\?xml[\t\n\r ]+version=(?:"1\.0"|'1\.0')(?:[\t\n\r ]+encoding=(?:"UTF-8"|'UTF-8'))?(?:[\t\n\r ]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[\t\n\r ]*\?>$/i.test(
        declaration,
      )
    ) {
      failXml();
    }
    index = declarationEnd + 2;
  }
  skipXmlWhitespaceAndComments();
  const root = parseElement(0);
  skipXmlWhitespaceAndComments();
  if (index !== xml.length) failXml();
  return root;

  function parseElement(depth) {
    if (depth > 64 || nodeCount >= 100_000 || xml[index] !== "<") failXml();
    if (xml.startsWith("</", index) || xml.startsWith("<!", index) || xml.startsWith("<?", index)) {
      failXml();
    }
    index += 1;
    const name = readXmlName();
    const attributes = new Set();
    nodeCount += 1;

    for (;;) {
      const beforeWhitespace = index;
      skipXmlWhitespace();
      if (xml.startsWith("/>", index)) {
        index += 2;
        return { children: [], name, text: "" };
      }
      if (xml[index] === ">") {
        index += 1;
        break;
      }
      if (index === beforeWhitespace) failXml();
      const attributeName = readXmlName();
      if (attributes.has(attributeName)) failXml();
      attributes.add(attributeName);
      skipXmlWhitespace();
      if (xml[index] !== "=") failXml();
      index += 1;
      skipXmlWhitespace();
      const quote = xml[index];
      if (quote !== '"' && quote !== "'") failXml();
      index += 1;
      const valueEnd = xml.indexOf(quote, index);
      if (valueEnd < 0) failXml();
      const attributeValue = xml.slice(index, valueEnd);
      if (attributeValue.includes("<")) failXml();
      decodeXmlText(attributeValue);
      index = valueEnd + 1;
    }

    const children = [];
    const textParts = [];
    for (;;) {
      if (index >= xml.length) failXml();
      if (xml.startsWith(`</`, index)) {
        index += 2;
        const endName = readXmlName();
        skipXmlWhitespace();
        if (endName !== name || xml[index] !== ">") failXml();
        index += 1;
        return { children, name, text: textParts.join("") };
      }
      if (xml.startsWith("<!--", index)) {
        skipXmlComment();
        continue;
      }
      if (xml[index] === "<") {
        children.push(parseElement(depth + 1));
        continue;
      }
      const textEnd = xml.indexOf("<", index);
      if (textEnd < 0) failXml();
      textParts.push(decodeXmlText(xml.slice(index, textEnd)));
      index = textEnd;
    }
  }

  function readXmlName() {
    const start = index;
    if (!/[A-Za-z_]/.test(xml[index] ?? "")) failXml();
    index += 1;
    while (/[A-Za-z0-9_.:-]/.test(xml[index] ?? "")) index += 1;
    const name = xml.slice(start, index);
    if (name.endsWith(":") || name.split(":").length > 2) failXml();
    return name;
  }

  function skipXmlWhitespace() {
    while (index < xml.length && /[\t\n\r ]/.test(xml[index])) index += 1;
  }

  function skipXmlWhitespaceAndComments() {
    for (;;) {
      skipXmlWhitespace();
      if (!xml.startsWith("<!--", index)) return;
      skipXmlComment();
    }
  }

  function skipXmlComment() {
    const commentEnd = xml.indexOf("-->", index + 4);
    if (commentEnd < 0 || xml.slice(index + 4, commentEnd).includes("--")) failXml();
    assertXmlCharacters(xml.slice(index + 4, commentEnd));
    index = commentEnd + 3;
  }

  function failXml() {
    throw new SafeInventoryError("R2 object listing returned unreadable XML.");
  }
}

function assertXmlCharacters(value) {
  for (const character of value) {
    if (!isValidXmlCodePoint(character.codePointAt(0))) {
      throw new SafeInventoryError("R2 object listing returned unreadable XML.");
    }
  }
}

function isValidXmlCodePoint(codePoint) {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function directXmlChildren(node, wantedLocalName) {
  return node.children.filter((child) => xmlLocalName(child.name) === wantedLocalName);
}

function readScalarXmlText(node) {
  if (node.children.length > 0) {
    throw new SafeInventoryError("R2 object listing returned unreadable XML.");
  }
  return node.text;
}

function xmlLocalName(name) {
  return name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
}

function decodeUrlEncodedKey(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SafeInventoryError("R2 object listing contains an invalid URL-encoded key.");
  }
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}
