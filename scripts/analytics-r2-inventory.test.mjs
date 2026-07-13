import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  INVENTORY_TOKEN_ENV,
  TEMPORARY_CREDENTIAL_TTL_SECONDS,
  parseListObjectsXml,
  runR2Inventory,
  signR2ListRequest,
  toInventoryRecords,
  writePrivateInventoryReport,
} from "./analytics/r2-inventory-lib.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const parentAccessKeyId = "fedcba9876543210fedcba9876543210";
const accountToken = "account-token-that-must-never-be-printed";
const bucket = "orange-replay-recordings-prod";
const credentials = {
  accessKeyId: "temporary-access-key",
  secretAccessKey: "temporary-secret-key",
  sessionToken: "temporary-session-token",
};

describe("production R2 inventory", () => {
  it("verifies the account token, mints one 15-minute bucket credential, and follows pages", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ init, url: String(url) });
      if (String(url).endsWith(`/accounts/${accountId}/tokens/verify`)) {
        return jsonResponse({
          errors: [],
          messages: [],
          result: { id: parentAccessKeyId, status: "active" },
          success: true,
        });
      }
      if (String(url).endsWith(`/accounts/${accountId}/r2/temp-access-credentials`)) {
        return jsonResponse({ errors: [], messages: [], result: credentials, success: true });
      }
      if (!String(url).includes("continuation-token=")) {
        return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <EncodingType>url</EncodingType>
            <IsTruncated>true</IsTruncated>
            <KeyCount>2</KeyCount>
            <Contents><Key>p%2Fproject%2Fa%26b%3Cc%3E%22%27.json</Key></Contents>
            <Contents><Key>z-last</Key></Contents>
            <NextContinuationToken>next&amp; page+token</NextContinuationToken>
          </ListBucketResult>`);
      }
      return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
          <EncodingType>url</EncodingType>
          <IsTruncated>false</IsTruncated>
          <KeyCount>2</KeyCount>
          <Contents><Key>alpha</Key></Contents>
          <Contents><Key>z-last</Key></Contents>
        </ListBucketResult>`);
    });
    const writeReport = vi.fn(async () => undefined);

    const result = await runR2Inventory(
      {
        accountId,
        bucket,
        offline: false,
        reportPath: "/private/inventory.json",
      },
      {
        accountToken,
        fetchImpl,
        now: () => new Date("2026-07-13T12:34:56.000Z"),
        writeReport,
      },
    );

    expect(result).toMatchObject({ mode: "complete", objectCount: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${accountToken}`);
    const mintBody = JSON.parse(calls[1].init.body);
    expect(mintBody).toEqual({
      bucket,
      parentAccessKeyId,
      permission: "object-read-only",
      ttlSeconds: TEMPORARY_CREDENTIAL_TTL_SECONDS,
    });
    expect(calls[2].url.endsWith(`/${bucket}?encoding-type=url&list-type=2`)).toBe(true);
    expect(calls[3].url).toContain(
      "continuation-token=next%26%20page%2Btoken&encoding-type=url&list-type=2",
    );
    expect(writeReport).toHaveBeenCalledWith("/private/inventory.json", [
      { key: "alpha" },
      { key: `p/project/a&b<c>"'.json` },
      { key: "z-last" },
    ]);
  });

  it("decodes escaped and numeric XML values without accepting unknown entities", () => {
    expect(
      parseListObjectsXml(`
        <ListBucketResult>
          <EncodingType>url</EncodingType>
          <IsTruncated>true</IsTruncated>
          <KeyCount>1</KeyCount>
          <Contents><Key>a%26b%2Fc%2Fd</Key></Contents>
          <NextContinuationToken>opaque&amp;next&#47;page</NextContinuationToken>
        </ListBucketResult>`),
    ).toEqual({
      isTruncated: true,
      keys: ["a&b/c/d"],
      nextContinuationToken: "opaque&next/page",
    });
    expect(() =>
      parseListObjectsXml(`
        <ListBucketResult>
          <EncodingType>url</EncodingType>
          <IsTruncated>false</IsTruncated>
          <KeyCount>1</KeyCount>
          <Contents><Key>unsafe&unknown;</Key></Contents>
        </ListBucketResult>`),
    ).toThrow("unreadable XML");
  });

  it("signs the session token as a header and keeps credentials out of the URL", () => {
    const request = signR2ListRequest({
      accountId,
      bucket,
      continuationToken: "opaque& value+?",
      credentials,
      now: new Date("2026-07-13T12:34:56.000Z"),
    });

    expect(request.url).toBe(
      `https://${accountId}.r2.cloudflarestorage.com/${bucket}?continuation-token=opaque%26%20value%2B%3F&encoding-type=url&list-type=2`,
    );
    expect(request.url).not.toContain(credentials.accessKeyId);
    expect(request.url).not.toContain(credentials.secretAccessKey);
    expect(request.url).not.toContain(credentials.sessionToken);
    expect(request.headers["x-amz-security-token"]).toBe(credentials.sessionToken);
    expect(request.headers.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
    expect(request.headers.authorization).not.toContain(credentials.secretAccessKey);
    expect(request.headers.authorization).not.toContain(credentials.sessionToken);
    expect(() =>
      signR2ListRequest({
        accountId,
        bucket,
        credentials: { ...credentials, sessionToken: "unsafe\nheader" },
      }),
    ).toThrow("incomplete");
  });

  it("normalizes an uppercase account ID before signing the wire hostname", () => {
    const input = {
      accountId: accountId.toUpperCase(),
      bucket,
      credentials,
      now: new Date("2026-07-13T12:34:56.000Z"),
    };
    const uppercaseRequest = signR2ListRequest(input);
    const lowercaseRequest = signR2ListRequest({ ...input, accountId });

    expect(uppercaseRequest.url).toBe(lowercaseRequest.url);
    expect(uppercaseRequest.headers.authorization).toBe(lowercaseRequest.headers.authorization);
  });

  it("rejects a truncated document and a key-count mismatch before writing", () => {
    expect(() =>
      parseListObjectsXml(`
        <ListBucketResult>
          <EncodingType>url</EncodingType>
          <IsTruncated>false</IsTruncated>
          <KeyCount>1</KeyCount>
          <Contents><Key>unfinished</Key></Contents>`),
    ).toThrow("unreadable XML");

    expect(() =>
      parseListObjectsXml(`
        <ListBucketResult>
          <EncodingType>url</EncodingType>
          <IsTruncated>false</IsTruncated>
          <KeyCount>2</KeyCount>
          <Contents><Key>only-first-key</Key></Contents>
        </ListBucketResult>`),
    ).toThrow("key count does not match");
  });

  it("writes only sorted deduped key records to a mode-0600 file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "orange-replay-r2-inventory-"));
    const reportPath = path.join(directory, "nested", "inventory.json");
    const records = toInventoryRecords(["z", "a", "z"]);

    await writePrivateInventoryReport(reportPath, records);

    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual([{ key: "a" }, { key: "z" }]);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    await expect(writePrivateInventoryReport(reportPath, records)).rejects.toThrow(
      "already exists",
    );
  });

  it("does no network or file work in offline mode and does not need a token", async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error("network should not run");
    });
    const writeReport = vi.fn(() => {
      throw new Error("write should not run");
    });

    const result = await runR2Inventory(
      {
        accountId,
        bucket,
        offline: true,
        reportPath: "/does/not/exist.json",
      },
      { fetchImpl, writeReport },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writeReport).not.toHaveBeenCalled();
    expect(result.plan).toMatchObject({
      fileWrites: 0,
      mode: "offline",
      networkRequests: 0,
      tokenEnvironmentVariable: INVENTORY_TOKEN_ENV,
    });
  });

  it("keeps API response text and tokens out of errors", async () => {
    const responseSecret = "response-body-secret";
    const fetchImpl = vi.fn(
      async () => new Response(`${responseSecret} ${accountToken}`, { status: 403 }),
    );

    let message = "";
    try {
      await runR2Inventory(
        {
          accountId,
          bucket,
          offline: false,
          reportPath: "/private/inventory.json",
        },
        { accountToken, fetchImpl, writeReport: vi.fn() },
      );
    } catch (error) {
      message = error.message;
    }
    expect(message).toBe("Cloudflare account-token check returned HTTP 403.");
    expect(message).not.toContain(responseSecret);
    expect(message).not.toContain(accountToken);
  });
});

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function xmlResponse(value) {
  return new Response(value, {
    headers: { "content-type": "application/xml" },
    status: 200,
  });
}
