import { markSdkInternalError } from "./internal-error.ts";
import type { SessionManager } from "./session.ts";

export function startSessionTouchListeners(
  win: Window,
  session: SessionManager,
  onIdle: () => void,
): () => void {
  let warned = false;
  const touch = () => {
    try {
      // touch() reads the clock once and reports idle without changing ids.
      // This avoids crossing the idle boundary between two separate reads.
      if (session.touch()) {
        onIdle();
      }
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
