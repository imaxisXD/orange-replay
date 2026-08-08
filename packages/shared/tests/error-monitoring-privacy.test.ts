import { describe, expect, it } from "vite-plus/test";
import {
  privateMonitoringDataCollection,
  sanitizeMonitoringEvent,
  sanitizeMonitoringSpan,
  sanitizeMonitoringUrl,
} from "../src/error-monitoring-privacy.ts";

describe("error monitoring privacy", () => {
  it("turns off every optional private data category", () => {
    expect(privateMonitoringDataCollection()).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
  });

  it("removes request identity, secrets, and recording routes from errors", () => {
    const event = sanitizeMonitoringEvent({
      user: { id: "user-secret", email: "person@example.com" },
      extra: { responseBody: "recording-payload" },
      transaction: "GET /projects/project-secret/sessions/session-secret?token=secret",
      message: "Failed at /p/public-secret?download=secret",
      exception: {
        values: [{ value: "Could not load /projects/project-secret?token=secret" }],
      },
      tags: { surface: "worker", projectId: "project-secret" },
      request: {
        url: "https://app.example.com/projects/project-secret/sessions/session-secret?token=secret",
        query_string: "token=secret",
        cookies: { session: "secret" },
        headers: { authorization: "Bearer secret" },
        data: "recording-payload",
      },
      breadcrumbs: [
        {
          message: "Opened /projects/project-secret/sessions/session-secret?token=secret",
          data: {
            from: "/projects/project-secret?token=secret",
            projectId: "project-secret",
            status_code: 500,
          },
        },
        {
          message:
            "analytics export session:project_019f3d49-a98c-7d71-a70e-d71eb70f8d7f:019f3d49-a98c-7d71-a70e-d71eb70f8d80 failed for person@example.com",
          data: {
            safe_nested_data: { recorderKey: "or_live_secret" },
          },
        },
      ],
    });

    expect(event).toEqual({
      transaction: "GET /projects/[projects]/sessions/[sessions]",
      message: "Failed at /p/[public-page]",
      exception: {
        values: [{ value: "Could not load /projects/[projects]" }],
      },
      tags: { surface: "worker" },
      request: {
        url: "https://app.example.com/projects/[projects]/sessions/[sessions]",
      },
      breadcrumbs: [
        {
          message: "Opened /projects/[projects]/sessions/[sessions]",
          data: {
            from: "/projects/[projects]",
            status_code: 500,
          },
        },
        {
          message: "analytics export [analytics-export] failed for [email]",
          data: {},
        },
      ],
    });
    expect(JSON.stringify(event)).not.toContain("secret");
  });

  it("keeps useful span facts while removing private attributes", () => {
    const span = sanitizeMonitoringSpan({
      description: "GET /api/v1/projects/project-secret/sessions/session-secret?cursor=secret",
      data: {
        "http.request.method": "GET",
        "http.response.status_code": 500,
        "url.full": "https://app.example.com/p/public-secret?token=secret",
        "route.params.projectId": "project-secret",
        "request.body": "recording-payload",
      },
    });

    expect(span).toEqual({
      description: "GET /api/v1/projects/[projects]/sessions/[sessions]",
      data: {
        "http.request.method": "GET",
        "http.response.status_code": 500,
        "url.full": "https://app.example.com/p/[public-page]",
      },
    });
  });

  it("drops credentials, queries, and hashes from absolute and local URLs", () => {
    expect(
      sanitizeMonitoringUrl(
        "https://name:password@app.example.com/onboarding/project-secret?step=2#install",
      ),
    ).toBe("https://app.example.com/onboarding/[onboarding]");
    expect(sanitizeMonitoringUrl("/p/public-secret?download=1")).toBe("/p/[public-page]");
  });

  it("redacts storage keys and common identifiers from free text", () => {
    const event = sanitizeMonitoringEvent({
      message:
        "R2 failed for p/project-secret/session-secret/manifest.json; projectId=project-secret; Bearer header-secret; or_live_recorder-secret",
      exception: {
        values: [{ value: "Session 019f3d49-a98c-7d71-a70e-d71eb70f8d80 failed" }],
      },
    });

    expect(event).toEqual({
      message:
        "R2 failed for p/[project]/[session]/manifest.json; projectId=[redacted]; Bearer [redacted]; [recorder-key]",
      exception: { values: [{ value: "Session [id] failed" }] },
    });
    expect(JSON.stringify(event)).not.toContain("secret");
  });
});
