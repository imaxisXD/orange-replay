// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { safeReturnPath } from "../src/lib/login-return";
import { defaultProjectId, projectIdFromProjectPath } from "../src/lib/routes";

describe("login return path", () => {
  it("keeps only local project routes", () => {
    expect(safeReturnPath("/projects/p1/sessions?limit=10#top")).toBe(
      "/projects/p1/sessions?limit=10#top",
    );
    expect(safeReturnPath("https://evil.example/projects/p1/sessions")).toBe(
      `/projects/${defaultProjectId}/overview`,
    );
    expect(safeReturnPath("//evil.example/projects/p1/sessions")).toBe(
      `/projects/${defaultProjectId}/overview`,
    );
    expect(safeReturnPath("/%5Cevil.example/projects/p1/sessions")).toBe(
      `/projects/${defaultProjectId}/overview`,
    );
    expect(safeReturnPath("/\\evil.example/projects/p1/sessions")).toBe(
      `/projects/${defaultProjectId}/overview`,
    );
    expect(safeReturnPath("/admin")).toBe(`/projects/${defaultProjectId}/overview`);
  });

  it("reads project ids from safe project routes", () => {
    expect(projectIdFromProjectPath("/projects/project_demo/sessions")).toBe("project_demo");
    expect(projectIdFromProjectPath("/projects/project%202/sessions")).toBe(defaultProjectId);
    expect(projectIdFromProjectPath("/admin")).toBe(defaultProjectId);
  });
});
