// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { loginReasonMessage, safeReturnPath } from "../src/lib/login-return";
import {
  defaultProjectId,
  localTokenReturnPath,
  projectIdFromProjectPath,
} from "../src/lib/routes";

describe("login return path", () => {
  it("keeps only local project routes", () => {
    expect(safeReturnPath("/projects/p1/sessions?limit=10#top")).toBe(
      "/projects/p1/sessions?limit=10#top",
    );
    expect(safeReturnPath("https://evil.example/projects/p1/sessions")).toBe("/projects");
    expect(safeReturnPath("//evil.example/projects/p1/sessions")).toBe("/projects");
    expect(safeReturnPath("/%5Cevil.example/projects/p1/sessions")).toBe("/projects");
    expect(safeReturnPath("/\\evil.example/projects/p1/sessions")).toBe("/projects");
    expect(safeReturnPath("/admin")).toBe("/projects");
    expect(safeReturnPath("/_admin")).toBe("/_admin");
    expect(safeReturnPath("/projects")).toBe("/projects");
  });

  it("reads project ids from safe project routes", () => {
    expect(projectIdFromProjectPath("/projects/project_demo/sessions")).toBe("project_demo");
    expect(projectIdFromProjectPath("/projects/project%202/sessions")).toBe(defaultProjectId);
    expect(projectIdFromProjectPath("/admin")).toBe(defaultProjectId);
  });

  it("sends local-token login to a concrete project", () => {
    expect(localTokenReturnPath("/projects/project_two/live")).toBe("/projects/project_two/live");
    expect(localTokenReturnPath("/projects")).toBe(`/projects/${defaultProjectId}/overview`);
    expect(localTokenReturnPath("/_admin")).toBe(`/projects/${defaultProjectId}/overview`);
  });

  it("uses the right message for hosted and local sign-in failures", () => {
    expect(loginReasonMessage("unauthorized", "github")).toBe(
      "GitHub sign-in was not completed. Try again.",
    );
    expect(loginReasonMessage("unauthorized", "token")).toBe(
      "That token was rejected. Check the owner API token and try again.",
    );
    expect(loginReasonMessage(undefined, "github")).toBe("");
  });
});
