// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { loginReasonMessage, safeReturnPath } from "../src/lib/login-return";

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

  it("uses the GitHub message for sign-in failures", () => {
    expect(loginReasonMessage("unauthorized", "github")).toBe(
      "GitHub sign-in was not completed. Try again.",
    );
    expect(loginReasonMessage(undefined, "github")).toBe("");
  });
});
