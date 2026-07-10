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
    expect(playbackReducer(state, { type: "timeline", durationMs: 12_000, deadClicks: [] })).toBe(
      state,
    );
  });

  it("stores dead clicks reported by the player", () => {
    const state = initialPlaybackState(12_000, "recorded");
    const nextState = playbackReducer(state, {
      type: "timeline",
      durationMs: 12_000,
      deadClicks: [{ t: 2_000, detail: "button.save" }],
    });

    expect(nextState.deadClicks).toEqual([{ t: 2_000, detail: "button.save" }]);
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

  it("resets visible playback state before retrying the engine", () => {
    const state = {
      ...initialPlaybackState(12_000, "recorded"),
      ready: true,
      buffering: true,
      playing: true,
      currentMs: 8_000,
      playerError: { message: "Could not decode replay." },
      speed: 2,
      skipIdle: true,
    };

    const nextState = playbackReducer(state, { type: "retry" });

    expect(nextState).toMatchObject({
      ready: false,
      buffering: false,
      playing: false,
      currentMs: 0,
      playerError: null,
      speed: 2,
      skipIdle: true,
    });
  });
});
