// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EventType, IncrementalSource, record, type eventWithTime } from "../src/index.ts";
import type { Mirror } from "../src/vendor/rrweb-snapshot/index.ts";
import { CanvasManager } from "../src/vendor/rrweb/record/observers/canvas/canvas-manager.ts";

const waitForMutationFlush = () => new Promise((resolve) => setTimeout(resolve, 30));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("record", () => {
  it("seals loaded images into a full snapshot", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,AQID",
    );

    const image = document.createElement("img");
    image.src = "/brand/logo.png";
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 80 },
      naturalHeight: { value: 80 },
    });
    document.body.appendChild(image);

    const events: eventWithTime[] = [];
    const stop = record({
      emit(event) {
        events.push(event);
      },
      inlineImages: true,
      recordAfter: "DOMContentLoaded",
    });

    const snapshot = events.find((event) => event.type === EventType.FullSnapshot);
    expect(JSON.stringify(snapshot)).toContain('"rr_dataURL":"data:image/png;base64,AQID"');
    stop?.();
  });

  it("emits snapshots, mutations, and masks input values", async () => {
    const events: eventWithTime[] = [];
    const stop = record({
      emit(event) {
        events.push(event);
      },
      maskAllInputs: true,
      recordAfter: "DOMContentLoaded",
    });

    expect(stop).toBeTypeOf("function");

    const container = document.createElement("section");
    container.textContent = "visible text";
    document.body.appendChild(container);
    await waitForMutationFlush();

    container.textContent = "changed text";
    await waitForMutationFlush();

    const input = document.createElement("input");
    input.type = "text";
    input.value = "secret-value";
    document.body.appendChild(input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForMutationFlush();

    stop?.();

    expect(events.some((event) => event.type === EventType.FullSnapshot)).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation,
      ),
    ).toBe(true);

    expect(JSON.stringify(events)).not.toContain("secret-value");
  });
});

describe("CanvasManager", () => {
  it("emits a deduplicated inline image frame", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    canvas.toBlob = (callback) => {
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }));
    };
    document.body.appendChild(canvas);

    const mutation = vi.fn();
    const manager = new CanvasManager({
      recordCanvas: true,
      mutationCb: mutation,
      win: window,
      blockClass: "rr-block",
      blockSelector: null,
      mirror: { getId: () => 12 } as unknown as Mirror,
      sampling: 2,
      dataURLOptions: { type: "image/webp", quality: 0.62 },
    });

    frameCallbacks.shift()?.(1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledWith({
      id: 12,
      type: 0,
      commands: [
        { property: "clearRect", args: [0, 0, 320, 180] },
        {
          property: "drawImage",
          args: [
            {
              rr_type: "ImageBitmap",
              args: [
                {
                  rr_type: "Blob",
                  data: [{ rr_type: "ArrayBuffer", base64: "AQID" }],
                  type: "image/webp",
                },
              ],
            },
            0,
            0,
            320,
            180,
          ],
        },
      ],
    });

    frameCallbacks.shift()?.(1_500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutation).toHaveBeenCalledTimes(1);

    manager.reset();
    expect(requestAnimationFrame).toHaveBeenCalled();
  });
});
