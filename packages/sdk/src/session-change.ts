/**
 * Keeps idle wake-ups and server-requested rotations in one serial queue.
 * A server close always wins, including when it arrives while an idle wake-up
 * is already being handled.
 */
export function createSessionChangeCoordinator(
  prepare: () => Promise<void>,
  resumeIdle: () => boolean | Promise<boolean>,
  startNew: () => void,
  resetRecorder: () => void,
): (startNewSession: boolean) => void {
  let newSessionPending = false;
  let running = false;

  const drainChanges = async (shouldResumeAfterIdle: boolean) => {
    do {
      await prepare();

      const shouldStartNewSession = newSessionPending;
      newSessionPending = false;
      let sessionChanged = false;
      if (shouldStartNewSession) {
        // A new server-closed session also satisfies any idle wake-up that
        // arrived while the current change was being prepared.
        startNew();
        sessionChanged = true;
      } else if (shouldResumeAfterIdle) {
        sessionChanged = await resumeIdle();
      }

      if (sessionChanged) {
        resetRecorder();
      }
      shouldResumeAfterIdle = false;
    } while (newSessionPending);
  };

  const requestChange = (startNewSession: boolean) => {
    if (startNewSession) newSessionPending = true;
    if (running) return;
    running = true;
    void drainChanges(!startNewSession).finally(() => {
      running = false;
      if (newSessionPending) requestChange(true);
    });
  };

  return requestChange;
}
