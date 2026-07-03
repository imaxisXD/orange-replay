import type { IndexEvent } from "@orange-replay/shared/types";
import type { eventWithTime } from "@orange-replay/rrweb-fork";
import { Recorder } from "./recorder.ts";
import { shouldSampleSession } from "./sampling.ts";
import { SessionManager } from "./session.ts";
import { InlineSink } from "./sink.ts";
import { Sidecar } from "./sidecar.ts";
import type { InitOptions, OrangeReplayHandle } from "./types.ts";
import { resolveInitOptions } from "./types.ts";

export type { InitOptions, OrangeReplayHandle, RecorderConfig } from "./types.ts";
export { buildLoaderSnippet, LOADER_SNIPPET_TEMPLATE } from "./loader.ts";
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
      return noopHandle((base) => session.getSessionUrl(base ?? config.ingestUrl));
    }

    const sink = new InlineSink({ config, session, window });
    const sidecar = new Sidecar({ config, sink, now: () => Date.now(), window });
    const recorder = new Recorder({ config, sink });
    const stopTouchListeners = startSessionTouchListeners(window, session);

    sink.start();
    sidecar.start();
    recorder.start();

    activeHandle = {
      async stop() {
        try {
          sidecar.stop();
          recorder.stop();
          stopTouchListeners();
          await sink.stop();
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

function startSessionTouchListeners(win: Window, session: SessionManager): () => void {
  const touch = () => {
    session.touch();
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
