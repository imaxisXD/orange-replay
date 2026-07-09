import { describe, expect, it } from "vite-plus/test";
import { initialPlaybackState, playbackReducer } from "../src/routes/session-detail/playback-state";

describe("playback state", () => {
  it("keeps the same state object for duplicate player events", () => {
    const state = initialPlaybackState(12_000, "recorded");

    expect(playbackReducer(state, { type: "buffering", buffering: false })).toBe(state);
    expect(playbackReducer(state, { type: "progress", currentMs: 0, durationMs: 12_000 })).toBe(
      state,
    );
    expect(
      playbackReducer(state, {
        type: "live",
        liveState: { following: false, connected: false },
      }),
    ).toBe(state);
  });

  it("creates new state when visible playback values change", () => {
    const state = initialPlaybackState(12_000, "recorded");
    const nextState = playbackReducer(state, {
      type: "progress",
      currentMs: 250,
      durationMs: 12_000,
    });

    expect(nextState).not.toBe(state);
    expect(nextState.currentMs).toBe(250);
  });
});
