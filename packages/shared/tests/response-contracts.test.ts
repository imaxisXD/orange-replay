import { describe, expect, it } from "vite-plus/test";
import {
  accountResponseSchema,
  createdProjectKeyResponseSchema,
  decodeAccountResponse,
  decodeCreatedProjectKeyResponse,
  decodeListSessionHeadsResponse,
  decodeListSessionsResponse,
  decodeSessionManifestResponse,
  decodeProjectKeysResponse,
  decodeProjectStatsResponse,
  projectKeysResponseSchema,
  projectStatsResponseSchema,
  sessionHeadSchema,
} from "../src/index.ts";
import {
  validAccountResponse,
  validCreatedProjectKeyResponse,
  validExactSessionHead,
  validListSessionHeadsResponse,
  validListSessionsResponse,
  validProjectKey,
  validProjectKeysResponse,
  validProjectStatsResponse,
  validProvisionalSessionHead,
  validSessionListItem,
} from "./response-contract-fixtures.ts";

describe("resource response contracts", () => {
  it("decodes valid project keys, accounts, stats, and sessions", () => {
    expect(decodeProjectKeysResponse(validProjectKeysResponse)).toEqual(validProjectKeysResponse);
    expect(decodeCreatedProjectKeyResponse(validCreatedProjectKeyResponse)).toEqual(
      validCreatedProjectKeyResponse,
    );
    expect(decodeAccountResponse(validAccountResponse)).toEqual(validAccountResponse);
    expect(decodeProjectStatsResponse(validProjectStatsResponse)).toEqual(
      validProjectStatsResponse,
    );
    expect(decodeListSessionsResponse(validListSessionsResponse)).toEqual(
      validListSessionsResponse,
    );
    expect(decodeListSessionHeadsResponse(validListSessionHeadsResponse)).toEqual(
      validListSessionHeadsResponse,
    );
  });

  it("accepts and removes unknown response fields", () => {
    expect(
      decodeAccountResponse({
        ...validAccountResponse,
        futureAccountField: true,
        user: { ...validAccountResponse.user, futureUserField: "new" },
      }),
    ).toEqual(validAccountResponse);

    expect(
      decodeProjectStatsResponse({
        ...validProjectStatsResponse,
        futureStatsField: true,
        filter: { ...validProjectStatsResponse.filter, futureFilterField: "new" },
      }),
    ).toEqual(validProjectStatsResponse);

    expect(
      decodeSessionManifestResponse({
        v: 1,
        sessionId: "session_contract",
        projectId: "project_contract",
        orgId: "workspace_contract",
        startedAt: 1_000,
        endedAt: 2_000,
        durationMs: 1_000,
        segments: [
          {
            key: "p/project_contract/session_contract/seg-000000.ors",
            bytes: 10,
            t0: 1_000,
            t1: 2_000,
            batches: 1,
            futureSegmentField: true,
          },
        ],
        timeline: [{ t: 1_100, k: "click", futureEventField: true }],
        counts: {
          batches: 1,
          events: 1,
          clicks: 1,
          errors: 0,
          rages: 0,
          navs: 0,
          futureCountField: true,
        },
        bytes: 10,
        flags: 0,
        attrs: { entryUrl: "/checkout", futureAttributeField: true },
        futureManifestField: true,
      }),
    ).toEqual({
      v: 1,
      sessionId: "session_contract",
      projectId: "project_contract",
      orgId: "workspace_contract",
      startedAt: 1_000,
      endedAt: 2_000,
      durationMs: 1_000,
      segments: [
        {
          key: "p/project_contract/session_contract/seg-000000.ors",
          bytes: 10,
          t0: 1_000,
          t1: 2_000,
          batches: 1,
        },
      ],
      timeline: [{ t: 1_100, k: "click" }],
      counts: { batches: 1, events: 1, clicks: 1, errors: 0, rages: 0, navs: 0 },
      bytes: 10,
      flags: 0,
      attrs: { entryUrl: "/checkout" },
    });
  });

  it("rejects missing required project key and account fields", () => {
    const { active: _active, ...keyWithoutActive } = validProjectKey;
    expect(projectKeysResponseSchema.safeParse({ keys: [keyWithoutActive] }).success).toBe(false);

    const { emailVerified: _emailVerified, ...userWithoutVerification } = validAccountResponse.user;
    expect(
      accountResponseSchema.safeParse({
        ...validAccountResponse,
        user: userWithoutVerification,
      }).success,
    ).toBe(false);
  });

  it("keeps write secrets limited to the create response", () => {
    const listed = decodeProjectKeysResponse({
      keys: [{ ...validProjectKeysResponse.keys[0], secret: "must_not_escape" }],
    });
    expect(listed).toEqual(validProjectKeysResponse);
    expect("secret" in (listed.keys[0] ?? {})).toBe(false);
    expect(
      createdProjectKeyResponseSchema.safeParse({ key: validProjectKeysResponse.keys[0] }).success,
    ).toBe(false);
  });

  it("rejects an active key with revocation details", () => {
    expect(
      projectKeysResponseSchema.safeParse({
        keys: [{ ...validProjectKeysResponse.keys[0], revokedAt: 2_000 }],
      }).success,
    ).toBe(false);
  });

  it("defaults the rolling activity histogram field when an older response omits it", () => {
    const { activity_hist: _activityHistogram, ...olderSession } = validSessionListItem;
    const decoded = decodeListSessionsResponse({
      sessions: [olderSession],
      nextBefore: null,
    });

    expect(decoded.sessions[0]?.activity_hist).toBeNull();
  });

  it("enforces exact and provisional session head semantics", () => {
    expect(sessionHeadSchema.safeParse(validExactSessionHead).success).toBe(true);
    expect(sessionHeadSchema.safeParse(validProvisionalSessionHead).success).toBe(true);
    expect(
      sessionHeadSchema.safeParse({ ...validExactSessionHead, replay_source: "live" }).success,
    ).toBe(false);
    expect(
      sessionHeadSchema.safeParse({ ...validProvisionalSessionHead, activity: "finalizing" })
        .success,
    ).toBe(false);
  });

  it("requires fresh and stale session lists to name their warehouse version", () => {
    const { warehouseVersion: _warehouseVersion, ...withoutVersion } = validListSessionsResponse;
    expect(() => decodeListSessionsResponse(withoutVersion)).toThrow();
  });

  it("enforces stats metadata and every metric doorway filter", () => {
    expect(projectStatsResponseSchema.safeParse(validProjectStatsResponse).success).toBe(true);

    const { warehouseVersion: _warehouseVersion, ...withoutVersion } = validProjectStatsResponse;
    expect(projectStatsResponseSchema.safeParse(withoutVersion).success).toBe(false);

    expect(
      projectStatsResponseSchema.safeParse({
        ...validProjectStatsResponse,
        sessions: { ...validProjectStatsResponse.sessions, filter: {} },
      }).success,
    ).toBe(false);

    expect(
      projectStatsResponseSchema.safeParse({
        ...validProjectStatsResponse,
        breakdowns: {
          ...validProjectStatsResponse.breakdowns,
          entryPage: [
            {
              ...validProjectStatsResponse.breakdowns.entryPage[0],
              filter: validProjectStatsResponse.filter,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps response filter whitespace exactly as it arrived on the wire", () => {
    const entryPageFilter = {
      ...validProjectStatsResponse.breakdowns.entryPage[0]!.filter,
      entry_url: " /checkout ",
    };
    const response = {
      ...validProjectStatsResponse,
      breakdowns: {
        ...validProjectStatsResponse.breakdowns,
        entryPage: [
          {
            label: " /checkout ",
            filter: entryPageFilter,
            count: { value: 2, filter: entryPageFilter },
            share: { value: 1, filter: entryPageFilter },
          },
        ],
      },
    };

    const decoded = decodeProjectStatsResponse(response);

    expect(decoded.breakdowns.entryPage[0]?.label).toBe(" /checkout ");
    expect(decoded.breakdowns.entryPage[0]?.filter.entry_url).toBe(" /checkout ");
    expect(decoded.breakdowns.entryPage[0]?.count.filter.entry_url).toBe(" /checkout ");
    expect(decoded.breakdowns.entryPage[0]?.share.filter.entry_url).toBe(" /checkout ");
  });
});
