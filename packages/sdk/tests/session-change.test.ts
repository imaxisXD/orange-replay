import { describe, expect, it, vi } from "vite-plus/test";
import { createSessionChangeCoordinator } from "../src/session-change.ts";

describe("session change coordinator", () => {
  it("does not lose a server close received during an idle resume", async () => {
    let finishIdleResume: ((changed: false) => void) | undefined;
    let markIdleResumeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markIdleResumeStarted = resolve;
    });
    const pendingIdleResume = new Promise<false>((resolve) => {
      finishIdleResume = resolve;
    });
    let markServerChangeFinished: (() => void) | undefined;
    const serverChangeFinished = new Promise<void>((resolve) => {
      markServerChangeFinished = resolve;
    });
    const actions: string[] = [];
    const changeSession = createSessionChangeCoordinator(
      vi.fn(async () => {
        actions.push("prepare");
      }),
      () => {
        actions.push("resume_idle");
        markIdleResumeStarted?.();
        return pendingIdleResume;
      },
      () => actions.push("start_new"),
      () => {
        actions.push("reset_recorder");
        markServerChangeFinished?.();
      },
    );

    changeSession(false);
    await started;
    changeSession(true);
    finishIdleResume?.(false);

    await serverChangeFinished;

    expect(actions).toEqual(["prepare", "resume_idle", "prepare", "start_new", "reset_recorder"]);
  });
});
