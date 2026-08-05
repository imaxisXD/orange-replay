// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  readOnboardingRecorderKey,
  saveOnboardingRecorderKey,
} from "../src/routes/onboarding/onboarding-recorder-key";

const projectId = "project_one";
const websiteId = "website_one";
const storageKey = `orange-replay:onboarding-recorder-key:${projectId}:${websiteId}`;
const recorderKey = `or_live_${"a".repeat(32)}`;

describe("onboarding recorder key storage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("returns a generated recorder key", () => {
    saveOnboardingRecorderKey(projectId, websiteId, recorderKey);

    expect(readOnboardingRecorderKey(projectId, websiteId)).toBe(recorderKey);
  });

  it("removes malformed stored values", () => {
    window.sessionStorage.setItem(storageKey, "not-a-recorder-key");

    expect(readOnboardingRecorderKey(projectId, websiteId)).toBeNull();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("does not replace storage with an invalid value", () => {
    window.sessionStorage.setItem(storageKey, recorderKey);

    saveOnboardingRecorderKey(projectId, websiteId, "wrong");

    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });
});
