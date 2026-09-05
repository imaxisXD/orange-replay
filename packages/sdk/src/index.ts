import type { IndexEvent } from "@orange-replay/shared/types";
import type { eventWithTime } from "@orange-replay/rrweb-fork";
import { CheckpointSnapshotLimiter } from "./checkpoint.ts";
import { createSdkHealthReporter } from "./health.ts";
import { assertSafePrivacySelectors, loadRecorderProjectConfig } from "./project-config.ts";
import { Recorder } from "./recorder.ts";
import { shouldSampleSession } from "./sampling.ts";
import { SessionManager } from "./session.ts";
import { startSessionTouchListeners } from "./session-touch.ts";
import { InlineSink, WorkerSink } from "./sink.ts";
import { discardLoaderPreBuffer, Sidecar } from "./sidecar.ts";
import type { InitOptions, OrangeReplayHandle } from "./types.ts";
import { resolveInitOptions } from "./types.ts";
import { captureDomMasking } from "./dom-masking.ts";

export type { InitOptions, OrangeReplayHandle, RecorderConfig } from "./types.ts";
export type { LoaderSnippetConfig } from "./loader.ts";

let activeHandle: OrangeReplayHandle | undefined;
const MAX_PENDING_CUSTOM_EVENTS = 20;

interface RecorderRuntime {
  sink: InlineSink | WorkerSink;
  sidecar: Sidecar;
  recorder: Recorder;
  stopTouchListeners: () => void;
}

export function init(options: InitOptions): OrangeReplayHandle {
  try {
    if (activeHandle !== undefined) {
      return activeHandle;
    }

    if (typeof window === "undefined" || typeof document === "undefined") {
      return noopHandle();
    }

    const localConfig = resolveInitOptions(options);
    const health = createSdkHealthReporter(localConfig, window.fetch.bind(window) as typeof fetch);
    let session: SessionManager | undefined;
    let stopRequested = false;
    let runtime: RecorderRuntime | undefined;
    let handle: OrangeReplayHandle;
    const pendingCustomEvents: Array<{ name: string; meta?: Record<string, unknown> }> = [];
    const startPromise = Promise.resolve()
      .then(async () => {
        const config = await loadRecorderProjectConfig(
          localConfig,
          window.fetch.bind(window) as typeof fetch,
          document,
          health,
        );
        const activeSession = new SessionManager({
          projectRef: config.sessionScope ?? config.projectId ?? localConfig.projectRef,
          now: () => Date.now(),
          cookieMode: window.location.protocol === "https:" ? "secure" : "none",
          cookieDomain: config.sessionCookieDomain,
          hostname: window.location.hostname,
        });
        session = activeSession;
        await activeSession.ready;
        activeSession.setProjectId(config.projectId);
        if (!shouldSampleSession(activeSession.sessionId, config.sampleRate)) {
          discardLoaderPreBuffer(window);
          activeSession.stop();
          return;
        }
        assertSafePrivacySelectors(config, document);
        config.appliedDomMasking = await captureDomMasking(config, localConfig);

        let checkpointSnapshots: CheckpointSnapshotLimiter | undefined;
        let workerFailedBeforeStart = false;
        let stopForWorkerFailure = () => {
          workerFailedBeforeStart = true;
        };
        let sink: InlineSink | WorkerSink;
        let recorder: Recorder;
        const requestCheckpointSnapshot = (required = false) => {
          if (required) recorder.takeFullSnapshot();
          else checkpointSnapshots?.requestSnapshot();
        };
        sink =
          config.transport === "inline"
            ? new InlineSink({
                config,
                session: activeSession,
                window,
                onCheckpointRequested: requestCheckpointSnapshot,
              })
            : new WorkerSink({
                config,
                session: activeSession,
                window,
                onCheckpointRequested: requestCheckpointSnapshot,
                onWorkerUnavailable: (code) => {
                  health(code);
                  stopForWorkerFailure();
                },
              });
        if (!sink.isAvailable()) {
          discardLoaderPreBuffer(window);
          activeSession.stop();
          if (activeHandle === handle) activeHandle = undefined;
          return;
        }
        const sidecar = new Sidecar({ config, sink, now: () => Date.now(), window });
        recorder = new Recorder({ config, sink });
        checkpointSnapshots = new CheckpointSnapshotLimiter({ recorder });
        if (stopRequested) {
          runtime = { sink, sidecar, recorder, stopTouchListeners: () => undefined };
          sidecar.drainPreBuffer();
          for (const event of pendingCustomEvents.splice(0)) {
            sidecar.addCustomEvent(event.name, event.meta);
          }
          return;
        }

        const stopTouchListeners = startSessionTouchListeners(window, activeSession, () => {
          sink.resumeSessionAfterIdle();
        });
        runtime = { sink, sidecar, recorder, stopTouchListeners };
        stopForWorkerFailure = () => {
          discardLoaderPreBuffer(window);
          runtime?.sidecar.stop();
          runtime?.recorder.stop();
          runtime?.stopTouchListeners();
          activeSession.stop();
          runtime = undefined;
          if (activeHandle === handle) activeHandle = undefined;
        };
        if (workerFailedBeforeStart) {
          stopForWorkerFailure();
          return;
        }

        recorder.start();
        sink.start();
        sidecar.start();
        for (const event of pendingCustomEvents.splice(0)) {
          const meta = sidecar.addCustomEvent(event.name, event.meta);
          recorder.addCustomEvent(event.name, meta);
        }
      })
      .catch(async (error) => {
        health("pipeline_stopped");
        console.warn("Orange Replay start failed.", error);
        discardLoaderPreBuffer(window);
        runtime?.sidecar.stop();
        runtime?.recorder.stop();
        runtime?.stopTouchListeners();
        await runtime?.sink.stop();
        session?.stop();
        runtime = undefined;
        if (activeHandle === handle) activeHandle = undefined;
      });

    handle = {
      async stop() {
        try {
          stopRequested = true;
          await startPromise;
          runtime?.sidecar.stop();
          runtime?.recorder.stop();
          runtime?.stopTouchListeners();
          await runtime?.sink.stop();
          session?.stop();
        } catch (error) {
          console.warn("Orange Replay stop failed.", error);
        } finally {
          if (activeHandle === handle) activeHandle = undefined;
        }
      },
      addCustomEvent(name: string, meta?: Record<string, unknown>) {
        try {
          if (runtime === undefined) {
            if (!stopRequested && pendingCustomEvents.length < MAX_PENDING_CUSTOM_EVENTS) {
              pendingCustomEvents.push({ name, meta });
            }
            return;
          }
          const cleanMeta = runtime.sidecar.addCustomEvent(name, meta);
          runtime.recorder.addCustomEvent(name, cleanMeta);
        } catch (error) {
          console.warn("Orange Replay custom event failed.", error);
        }
      },
      getSessionUrl(base?: string) {
        try {
          return session?.getSessionUrl(base ?? localConfig.ingestUrl) ?? "";
        } catch {
          return "";
        }
      },
    };
    activeHandle = handle;

    return handle;
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

export type { IndexEvent, eventWithTime };
