import type { IndexEvent } from "@orange-replay/shared/types";
import type { eventWithTime } from "@orange-replay/rrweb-fork";
import { CheckpointSnapshotLimiter } from "./checkpoint.ts";
import { markSdkInternalError } from "./internal-error.ts";
import { Recorder } from "./recorder.ts";
import { shouldSampleSession } from "./sampling.ts";
import { SessionManager } from "./session.ts";
import { InlineSink, WorkerSink } from "./sink.ts";
import { Sidecar } from "./sidecar.ts";
import type { InitOptions, OrangeReplayHandle } from "./types.ts";
import { resolveInitOptions } from "./types.ts";

export type { InitOptions, OrangeReplayHandle, RecorderConfig } from "./types.ts";
export type { LoaderSnippetConfig } from "./loader.ts";

let activeHandle: OrangeReplayHandle | undefined;

export function init(options: InitOptions): OrangeReplayHandle {
  try {
    if (activeHandle !== undefined) {
      return activeHandle;
    }

    if (typeof window === "undefined" || typeof document === "undefined") {
      return noopHandle();
    }

    const config = resolveInitOptions(options);
    const session = new SessionManager({
      projectRef: config.projectRef,
      now: () => Date.now(),
    });

    if (!shouldSampleSession(session.sessionId, config.sampleRate)) {
      void session.ready.then(() => session.stop());
      return noopHandle((base) => session.getSessionUrl(base ?? config.ingestUrl));
    }

    let rotationPromise: Promise<void> | undefined;
    let started = false;
    let stopRequested = false;
    let stopTouchListeners: (() => void) | undefined;
    let checkpointSnapshots: CheckpointSnapshotLimiter | undefined;
    const requestCheckpointSnapshot = () => {
      checkpointSnapshots?.requestSnapshot();
    };
    const rotateSession = () => {
      if (rotationPromise !== undefined) {
        return rotationPromise;
      }

      rotationPromise = (async () => {
        await sink.prepareForSessionRotation();
        session.rotate();
        sink.resetAfterSessionRotation();
        recorder.takeFullSnapshot();
      })().finally(() => {
        rotationPromise = undefined;
      });

      return rotationPromise;
    };

    const sink =
      config.transport === "inline"
        ? new InlineSink({
            config,
            session,
            window,
            onSessionClosed() {
              void rotateSession();
            },
            onCheckpointRequested: requestCheckpointSnapshot,
          })
        : new WorkerSink({
            config,
            session,
            window,
            onSessionClosed() {
              void rotateSession();
            },
            onCheckpointRequested: requestCheckpointSnapshot,
          });
    const sidecar = new Sidecar({ config, sink, now: () => Date.now(), window });
    const recorder = new Recorder({ config, sink });
    checkpointSnapshots = new CheckpointSnapshotLimiter({ recorder });
    const startPromise = session.ready.then(() => {
      if (stopRequested) {
        return;
      }

      stopTouchListeners = startSessionTouchListeners(window, session, () => {
        void rotateSession();
      });
      sink.start();
      sidecar.start();
      recorder.start();
      started = true;
    });

    activeHandle = {
      async stop() {
        try {
          stopRequested = true;
          await startPromise;
          if (!started) {
            sidecar.drainPreBuffer();
          }
          sidecar.stop();
          recorder.stop();
          stopTouchListeners?.();
          await sink.stop();
          session.stop();
        } catch (error) {
          console.warn("Orange Replay stop failed.", error);
        } finally {
          activeHandle = undefined;
        }
      },
      addCustomEvent(name: string, meta?: Record<string, unknown>) {
        try {
          sidecar.addCustomEvent(name, meta);
          recorder.addCustomEvent(name, meta ?? {});
        } catch (error) {
          console.warn("Orange Replay custom event failed.", error);
        }
      },
      getSessionUrl(base?: string) {
        try {
          return session.getSessionUrl(base ?? config.ingestUrl);
        } catch {
          return "";
        }
      },
    };

    return activeHandle;
  } catch (error) {
    console.warn("Orange Replay init failed.", error);
    return noopHandle();
  }
}

function noopHandle(getUrl?: (base?: string) => string): OrangeReplayHandle {
  return {
    async stop() {
      /* no-op */
    },
    addCustomEvent() {
      /* no-op */
    },
    getSessionUrl(base?: string) {
      return getUrl?.(base) ?? "";
    },
  };
}

function startSessionTouchListeners(
  win: Window,
  session: SessionManager,
  onRotate: () => void,
): () => void {
  let warned = false;
  const touch = () => {
    try {
      if (session.shouldRotateForIdle()) {
        onRotate();
        return;
      }

      session.touch();
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn("Orange Replay session update failed.", markSdkInternalError(error));
      }
    }
  };
  const events = ["click", "keydown", "scroll", "visibilitychange"];

  for (const event of events) {
    win.addEventListener(event, touch, true);
  }

  return () => {
    for (const event of events) {
      win.removeEventListener(event, touch, true);
    }
  };
}

export type { IndexEvent, eventWithTime };

type LoaderWindow = Window & {
  __orInit?: InitOptions;
  __orq?: unknown[];
};

function readLoaderInit(win: LoaderWindow): InitOptions | undefined {
  if (isInitOptions(win.__orInit)) {
    return win.__orInit;
  }

  if (!Array.isArray(win.__orq)) {
    return undefined;
  }

  for (const item of win.__orq) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const record = item as { k?: unknown; o?: unknown };
    if (record.k === "init" && isInitOptions(record.o)) {
      return record.o;
    }
  }

  return undefined;
}

function isInitOptions(value: unknown): value is InitOptions {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const options = value as Partial<InitOptions>;
  return typeof options.key === "string" && typeof options.ingestUrl === "string";
}

declare const __ORANGE_REPLAY_AUTO_INIT__: boolean | undefined;

if (
  typeof __ORANGE_REPLAY_AUTO_INIT__ !== "undefined" &&
  __ORANGE_REPLAY_AUTO_INIT__ &&
  typeof window !== "undefined"
) {
  const startFromLoader = () => {
    if (activeHandle !== undefined) {
      return;
    }

    const options = readLoaderInit(window as LoaderWindow);
    if (options !== undefined) {
      init(options);
    }
  };

  if (typeof window.queueMicrotask === "function") {
    window.queueMicrotask(startFromLoader);
  } else {
    void Promise.resolve().then(startFromLoader);
  }
}
