// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EventType,
  IncrementalSource,
  mirror as publicMirror,
  NodeType,
  record,
  type eventWithTime,
} from "../src/index.ts";
import {
  cleanupSnapshot,
  Mirror,
  snapshot,
  snapshotInChunks,
} from "../src/vendor/rrweb-snapshot/index.ts";
import { CanvasManager } from "../src/vendor/rrweb/record/observers/canvas/canvas-manager.ts";
import { ImageManager } from "../src/vendor/rrweb/record/observers/image-manager.ts";
import { IframeManager } from "../src/vendor/rrweb/record/iframe-manager.ts";
import MutationBuffer from "../src/vendor/rrweb/record/mutation.ts";
import {
  initAdoptedStyleSheetObserver,
  mutationBuffers,
} from "../src/vendor/rrweb/record/observer.ts";
import { StylesheetManager } from "../src/vendor/rrweb/record/stylesheet-manager.ts";

const waitForMutationFlush = () => new Promise((resolve) => setTimeout(resolve, 30));
let stopRecording: (() => void) | undefined;

afterEach(() => {
  stopRecording?.();
  stopRecording = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("record", () => {
  it("does not emit stylesheet content after its owner becomes blocked", async () => {
    const style = document.createElement("style");
    style.textContent = "@media screen { .private-target { color: black; } }";
    document.head.appendChild(style);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      blockSelector: "[data-orange-block]",
    });
    await waitForFullSnapshot(events);
    const eventCut = events.length;
    const mediaRule = style.sheet?.cssRules[0] as CSSMediaRule | undefined;

    style.dataset.orangeBlock = "";
    await waitForMutationFlush();
    style.sheet?.insertRule(
      '.private-rule { background-image: url("https://private.example/stylesheet-leak"); }',
    );
    const firstRule = style.sheet?.cssRules[0] as CSSStyleRule | undefined;
    firstRule?.style.setProperty(
      "background-image",
      'url("https://private.example/declaration-leak")',
    );
    style.sheet?.deleteRule(0);
    mediaRule?.insertRule(
      '.private-nested { background-image: url("https://private.example/nested-leak"); }',
    );
    mediaRule?.deleteRule(0);
    await waitForMutationFlush();

    expect(JSON.stringify(events.slice(eventCut))).not.toContain("private.example");
    expect(
      events
        .slice(eventCut)
        .filter(
          (event) =>
            event.type === EventType.IncrementalSnapshot &&
            (event.data.source === IncrementalSource.StyleSheetRule ||
              event.data.source === IncrementalSource.StyleDeclaration),
        ),
    ).toEqual([]);
  });

  it("does not emit stylesheet content after a shadow host becomes blocked", async () => {
    const host = document.createElement("section");
    document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ".public-shadow { color: orange; }";
    shadowRoot.appendChild(style);
    const constructedSheet = new CSSStyleSheet();
    constructedSheet.replaceSync(".public-constructed { color: orange; }");
    shadowRoot.adoptedStyleSheets = [constructedSheet];
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      blockSelector: "[data-orange-block]",
    });
    await waitForFullSnapshot(events);
    await waitForMutationFlush();
    const eventCut = events.length;

    host.dataset.orangeBlock = "";
    style.sheet?.insertRule(
      '.private-shadow { background-image: url("https://private.example/shadow-leak"); }',
    );
    constructedSheet.replaceSync(
      '.private-replace-sync { background-image: url("https://private.example/replace-sync"); }',
    );
    await constructedSheet.replace(
      '.private-replace { background-image: url("https://private.example/replace"); }',
    );
    await waitForMutationFlush();

    expect(JSON.stringify(events.slice(eventCut))).not.toContain("private.example");
  });

  it("does not emit stylesheet content after an iframe becomes blocked", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument!;
    const style = iframeDocument.createElement("style");
    style.textContent = ".public-frame { color: orange; }";
    iframeDocument.head.appendChild(style);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      blockSelector: "[data-orange-block]",
    });
    await waitForFullSnapshot(events);
    await waitForMutationFlush();
    const eventCut = events.length;

    iframe.dataset.orangeBlock = "";
    style.sheet?.insertRule(
      '.private-frame { background-image: url("https://private.example/frame-leak"); }',
    );
    await waitForMutationFlush();

    expect(JSON.stringify(events.slice(eventCut))).not.toContain("private.example/frame-leak");
  });

  it("continues recording stylesheet changes owned by unblocked elements", async () => {
    const style = document.createElement("style");
    document.head.appendChild(style);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
    });
    await waitForFullSnapshot(events);
    const eventCut = events.length;

    style.sheet?.insertRule(".public-rule { color: orange; }");
    await waitForMutationFlush();

    expect(JSON.stringify(events.slice(eventCut))).toContain("public-rule");
  });

  it("keeps interaction events when DOM recording is disabled", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordDOM: false,
      recordAfter: "DOMContentLoaded",
    });

    input.value = "still-recorded";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(events.some((event) => event.type === EventType.FullSnapshot)).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Input &&
          event.data.text === "still-recorded",
      ),
    ).toBe(true);
  });

  it("seals loaded images after the full snapshot without blocking it", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const encodeImageNow = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }));
    });

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
    stopRecording = stop;

    await waitForFullSnapshot(events, frameCallbacks);
    const snapshot = events.find((event) => event.type === EventType.FullSnapshot);
    expect(JSON.stringify(snapshot)).not.toContain("/brand/logo.png");
    expect(encodeImageNow).not.toHaveBeenCalled();

    frameCallbacks.shift()?.(1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(JSON.stringify(events)).toContain('"src":"data:image/webp;base64,AQID"');
    stop?.();
    stopRecording = undefined;
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
    stopRecording = stop;

    expect(stop).toBeTypeOf("function");
    await waitForFullSnapshot(events);

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
    stopRecording = undefined;

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

  it("does not encode canvas pixels during a full snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const encodeCanvasNow = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/webp;base64,AQID");

    const canvas = document.createElement("canvas");
    canvas.width = 1_920;
    canvas.height = 1_080;
    document.body.appendChild(canvas);

    const events: eventWithTime[] = [];
    const stop = record({
      emit(event) {
        events.push(event);
      },
      recordCanvas: true,
      recordAfter: "DOMContentLoaded",
    });
    stopRecording = stop;

    await waitForFullSnapshot(events, frameCallbacks);
    expect(events.some((event) => event.type === EventType.FullSnapshot)).toBe(true);
    expect(encodeCanvasNow).not.toHaveBeenCalled();
    expect(frameCallbacks.length).toBeGreaterThan(0);
    stop?.();
    stopRecording = undefined;
  });

  it("keeps slim DOM nodes ignored in the live mirror", async () => {
    const script = document.createElement("script");
    script.type = "application/json";
    script.textContent = "ignored script";
    document.head.appendChild(script);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      slimDOMOptions: true,
    });

    await waitForFullSnapshot(events);

    expect(record.mirror.getId(script)).toBe(-2);
    stopRecording?.();
    stopRecording = undefined;
  });

  it("keeps a slim DOM node ignored after remove and reinsert during a snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    for (let index = 0; index < 20; index += 1) {
      document.head.appendChild(document.createElement("meta"));
    }
    const script = document.createElement("script");
    script.dataset.testNode = "slim-reinsert";
    document.head.appendChild(script);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      slimDOMOptions: true,
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    await startChunkedSnapshot(frameCallbacks);
    script.remove();
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);
    document.head.appendChild(script);
    await waitForMutationFlush();

    expect(record.mirror.getId(script)).toBe(-2);
    expect(JSON.stringify(events)).not.toContain("slim-reinsert");
    stopRecording?.();
    stopRecording = undefined;
  });

  it("buffers mutations until a chunked initial snapshot is complete", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    for (let index = 0; index < 20; index += 1) {
      const row = document.createElement("div");
      row.textContent = `row-${index}`;
      document.body.appendChild(row);
    }

    const events: eventWithTime[] = [];
    const stop = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    stopRecording = stop;

    await startChunkedSnapshot(frameCallbacks);
    const lateNode = document.createElement("strong");
    lateNode.textContent = "late-node";
    document.body.appendChild(lateNode);
    await drainSnapshotFrames(frameCallbacks, events);

    const fullSnapshotIndex = events.findIndex((event) => event.type === EventType.FullSnapshot);
    const firstMutationIndex = events.findIndex(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation,
    );
    expect(fullSnapshotIndex).toBeGreaterThan(-1);
    expect(firstMutationIndex === -1 || firstMutationIndex > fullSnapshotIndex).toBe(true);
    expect(JSON.stringify(events).match(/late-node/g) ?? []).toHaveLength(1);

    stop?.();
    stopRecording = undefined;
  });

  it("finishes one baseline while a text counter keeps changing", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const counter = document.createTextNode("count-0");
    document.body.appendChild(counter);
    for (let index = 0; index < 80; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    let completedWhileUpdating = false;
    for (let frame = 0; frame < 500; frame += 1) {
      counter.data = `count-${frame + 1}`;
      await new Promise((resolve) => setTimeout(resolve, 0));
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (events.some((event) => event.type === EventType.FullSnapshot)) {
        completedWhileUpdating = true;
        break;
      }
    }

    expect(completedWhileUpdating).toBe(true);
    expect(events.filter((event) => event.type === EventType.FullSnapshot)).toHaveLength(1);
  });

  it("coalesces distinct and repeated snapshot catch-up updates without restarting", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const textNodes = Array.from({ length: 400 }, (_, index) => {
      const row = document.createElement("div");
      const text = document.createTextNode(`before-${index}`);
      row.appendChild(text);
      document.body.appendChild(row);
      return text;
    });
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    await runSnapshotFramesUntil(
      frameCallbacks,
      () => record.mirror.isActiveNode(textNodes.at(-1)!),
      2_000,
    );
    expect(events.some((event) => event.type === EventType.FullSnapshot)).toBe(false);
    for (let index = 0; index < textNodes.length; index += 1) {
      textNodes[index]!.data = `after-${index}`;
      textNodes[index]!.parentElement!.setAttribute("data-state", `after-${index}`);
      await Promise.resolve();
    }
    const repeatedText = textNodes[0]!;
    const repeatedElement = repeatedText.parentElement!;
    const padding = "z".repeat(300);
    for (let index = 0; index < 3_000; index += 1) {
      repeatedText.data = `repeat-text-${index}-${padding}`;
      repeatedElement.setAttribute("data-repeat", `repeat-attribute-${index}-${padding}`);
      await Promise.resolve();
    }
    await drainSnapshotFramesQuick(frameCallbacks, events, 3_000);

    expect(events.filter((event) => event.type === EventType.Meta)).toHaveLength(1);
    expect(events.filter((event) => event.type === EventType.FullSnapshot)).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation,
      ).length,
    ).toBeLessThanOrEqual(1);
    expect(JSON.stringify(events)).toContain(`repeat-text-2999-${padding}`);
    expect(JSON.stringify(events)).toContain(`repeat-attribute-2999-${padding}`);
    expect(JSON.stringify(events)).toContain("after-399");
  });

  it("keeps interactions during snapshot preparation after the baseline", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const button = document.createElement("button");
    button.dataset.testNode = "early-button";
    document.body.appendChild(button);

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const earlyNode = document.createElement("div");
    earlyNode.dataset.testNode = "early-node";
    document.body.appendChild(earlyNode);
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const fullSnapshotIndex = events.findIndex((event) => event.type === EventType.FullSnapshot);
    const fullSnapshot = events[fullSnapshotIndex]!;
    const root = (fullSnapshot as eventWithTime & { data: { node: SnapshotNode } }).data.node;
    const buttonNode = findSnapshotElement(root, "early-button")!;
    expect(findSnapshotElement(root, "early-node")).toBeDefined();
    const clickIndex = events.findIndex(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.MouseInteraction &&
        "id" in event.data &&
        event.data.id === buttonNode.id,
    );
    expect(clickIndex).toBeGreaterThan(fullSnapshotIndex);

    stopRecording?.();
    stopRecording = undefined;
  });

  it("keeps removals, moves, and intermediate changes made during a snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const source = document.createElement("section");
    source.dataset.testNode = "source";
    const target = document.createElement("section");
    target.dataset.testNode = "target";
    const removed = document.createElement("div");
    removed.dataset.testNode = "removed";
    const moved = document.createElement("div");
    moved.dataset.testNode = "moved";
    const changed = document.createElement("button");
    changed.dataset.testNode = "changed";
    changed.dataset.state = "A";
    const removedScript = document.createElement("script");
    removedScript.type = "application/json";
    removedScript.textContent = "private-script-text";
    source.append(removed, moved, changed, removedScript);
    document.body.append(source, target);
    for (let index = 0; index < 20; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    await startChunkedSnapshot(frameCallbacks);
    for (let frame = 0; frame < 100 && !record.mirror.isActiveNode(changed); frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(record.mirror.getId(changed)).toBeGreaterThan(0);
    expect(record.mirror.isActiveNode(changed)).toBe(true);
    changed.setAttribute("data-state", "B");
    await waitForMutationFlush();
    expect(record.mirror.isActiveNode(changed)).toBe(true);
    changed.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    changed.setAttribute("data-state", "A");
    await waitForMutationFlush();
    removed.remove();
    removedScript.remove();
    target.appendChild(moved);
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const fullSnapshotIndex = events.findIndex((event) => event.type === EventType.FullSnapshot);
    const fullSnapshot = events[fullSnapshotIndex]!;
    expect(JSON.stringify(fullSnapshot)).not.toContain("private-script-text");
    const root = (fullSnapshot as eventWithTime & { data: { node: SnapshotNode } }).data.node;
    const targetNode = findSnapshotElement(root, "target")!;
    const removedNode = findSnapshotElement(root, "removed");
    const movedNode = findSnapshotElement(root, "moved")!;
    const changedNode = findSnapshotElement(root, "changed")!;
    const movedWasCapturedInTarget =
      targetNode.childNodes?.some((node) => node.id === movedNode.id) === true;

    const mutations = events.filter(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation,
    );
    const mutationText = JSON.stringify(mutations);
    if (removedNode !== undefined) {
      expect(mutationText).toContain(`"id":${removedNode.id}`);
    }
    if (!movedWasCapturedInTarget) {
      expect(mutationText).toContain(`"parentId":${targetNode.id}`);
      expect(mutationText).toContain(`"id":${movedNode.id}`);
    }
    expect(mutationText).toContain('"data-state":"B"');
    expect(mutationText).toContain('"data-state":"A"');
    expect(mutations.every((event) => events.indexOf(event) > fullSnapshotIndex)).toBe(true);

    const click = events.find(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.MouseInteraction &&
        "id" in event.data &&
        event.data.id === changedNode.id,
    );
    expect(click).toBeDefined();
    expect(click!.timestamp).toBeGreaterThanOrEqual(fullSnapshot.timestamp);

    stopRecording?.();
    stopRecording = undefined;
  });

  it("keeps same-parent reorders atomic during topology capture", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const parent = document.createElement("section");
    const first = document.createElement("div");
    const second = document.createElement("div");
    const moved = document.createElement("div");
    moved.dataset.testNode = "same-parent-move";
    parent.append(first, second, moved);
    document.body.appendChild(parent);
    const fillers = Array.from({ length: 1_050 }, () => {
      const filler = document.createElement("div");
      document.body.appendChild(filler);
      return filler;
    });
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    await runSnapshotFramesUntil(
      frameCallbacks,
      () => record.mirror.isActiveNode(fillers[1_024]!),
      3_000,
    );
    parent.insertBefore(moved, first);
    await waitForMutationFlush();
    await drainSnapshotFramesQuick(frameCallbacks, events, 10_000);
    const movedId = record.mirror.getId(moved);
    const mutations = events.filter(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation,
    );
    const hasAdd = mutations.some(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation &&
        event.data.adds.some((addition) => addition.node.id === movedId),
    );
    const hasRemove = mutations.some(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation &&
        event.data.removes.some((removal) => removal.id === movedId),
    );
    expect(hasAdd).toBe(hasRemove);
  });

  it("keeps an untouched sibling when the pending cursor is removed", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const parent = document.createElement("section");
    const first = document.createElement("div");
    first.dataset.testNode = "cursor-first";
    const pendingCursor = document.createElement("div");
    pendingCursor.dataset.testNode = "cursor-removed";
    const untouched = document.createElement("div");
    untouched.dataset.testNode = "cursor-untouched";
    parent.append(first, pendingCursor, untouched);
    document.body.appendChild(parent);
    for (let index = 0; index < 30; index += 1)
      document.body.appendChild(document.createElement("div"));

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    for (let frame = 0; frame < 200; frame += 1) {
      if (record.mirror.isActiveNode(parent) && !record.mirror.isActiveNode(first)) break;
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(record.mirror.isActiveNode(parent)).toBe(true);
    expect(record.mirror.isActiveNode(first)).toBe(false);
    pendingCursor.remove();
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const fullSnapshot = events.find((event) => event.type === EventType.FullSnapshot)!;
    const root = (fullSnapshot as eventWithTime & { data: { node: SnapshotNode } }).data.node;
    expect(findSnapshotElement(root, "cursor-untouched")).toBeDefined();
  });

  it("keeps a second move and a later removal after the topology captured the first move", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const source = document.createElement("section");
    source.dataset.testNode = "move-source";
    const middle = document.createElement("section");
    middle.dataset.testNode = "move-middle";
    const final = document.createElement("section");
    final.dataset.testNode = "move-final";
    const movedTwice = document.createElement("div");
    movedTwice.dataset.testNode = "moved-twice";
    const movedThenRemoved = document.createElement("div");
    movedThenRemoved.dataset.testNode = "moved-then-removed";
    const sentinel = document.createElement("div");
    sentinel.dataset.testNode = "move-sentinel";
    source.append(movedTwice, movedThenRemoved);
    middle.appendChild(sentinel);
    document.body.append(source, middle, final);
    for (let index = 0; index < 40; index += 1)
      document.body.appendChild(document.createElement("div"));

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    await startChunkedSnapshot(frameCallbacks);
    middle.insertBefore(movedTwice, sentinel);
    middle.insertBefore(movedThenRemoved, sentinel);
    await waitForMutationFlush();
    for (let frame = 0; frame < 300 && !record.mirror.isActiveNode(sentinel); frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(record.mirror.isActiveNode(sentinel)).toBe(true);
    final.appendChild(movedTwice);
    movedThenRemoved.remove();
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const fullSnapshotIndex = events.findIndex((event) => event.type === EventType.FullSnapshot);
    const fullSnapshot = events[fullSnapshotIndex]!;
    const root = (fullSnapshot as eventWithTime & { data: { node: SnapshotNode } }).data.node;
    const middleNode = findSnapshotElement(root, "move-middle")!;
    const finalNode = findSnapshotElement(root, "move-final")!;
    const movedTwiceNode = findSnapshotElement(root, "moved-twice")!;
    const removedNode = findSnapshotElement(root, "moved-then-removed")!;
    expect(middleNode.childNodes?.some((child) => child.id === movedTwiceNode.id)).toBe(true);
    expect(middleNode.childNodes?.some((child) => child.id === removedNode.id)).toBe(true);

    const laterMutations = events
      .slice(fullSnapshotIndex + 1)
      .filter(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation,
      );
    expect(
      laterMutations.some(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation &&
          event.data.adds.some(
            (addition) =>
              addition.node.id === movedTwiceNode.id && addition.parentId === finalNode.id,
          ),
      ),
    ).toBe(true);
    expect(
      laterMutations.some(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation &&
          event.data.removes.some(
            (removal) => removal.id === movedTwiceNode.id && removal.parentId === middleNode.id,
          ),
      ),
    ).toBe(true);
    expect(
      laterMutations.some(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation &&
          event.data.removes.some(
            (removal) => removal.id === removedNode.id && removal.parentId === middleNode.id,
          ),
      ),
    ).toBe(true);
  });

  it("drops the full move chain when topology captures the final parent", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    for (let index = 0; index < 40; index += 1)
      document.body.appendChild(document.createElement("div"));
    const source = document.createElement("section");
    source.dataset.testNode = "chain-source";
    const middle = document.createElement("section");
    middle.dataset.testNode = "chain-middle";
    const final = document.createElement("section");
    final.dataset.testNode = "chain-final";
    const moved = document.createElement("div");
    moved.dataset.testNode = "chain-moved";
    source.appendChild(moved);
    document.body.append(source, middle, final);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    await startChunkedSnapshot(frameCallbacks);
    middle.appendChild(moved);
    await waitForMutationFlush();
    final.appendChild(moved);
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const fullSnapshotIndex = events.findIndex((event) => event.type === EventType.FullSnapshot);
    const root = (events[fullSnapshotIndex] as eventWithTime & { data: { node: SnapshotNode } })
      .data.node;
    const finalNode = findSnapshotElement(root, "chain-final")!;
    const movedNode = findSnapshotElement(root, "chain-moved")!;
    expect(finalNode.childNodes?.some((child) => child.id === movedNode.id)).toBe(true);
    const laterMutations = events
      .slice(fullSnapshotIndex + 1)
      .filter(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation,
      );
    expect(JSON.stringify(laterMutations)).not.toContain(`"id":${movedNode.id}`);
  });

  it("restarts safely while an older sliced snapshot is still yielding", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    for (let index = 0; index < 40; index += 1)
      document.body.appendChild(document.createElement("div"));
    const firstEvents: eventWithTime[] = [];
    const stopFirst = record({
      emit: (event) => firstEvents.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    const cachedGetId = publicMirror.getId;
    await startChunkedSnapshot(frameCallbacks);
    stopFirst?.();

    const marker = document.createElement("strong");
    marker.dataset.testNode = "restart-marker";
    document.body.appendChild(marker);
    const secondEvents: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => secondEvents.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    await drainSnapshotFrames(frameCallbacks, secondEvents);

    const fullSnapshot = secondEvents.find((event) => event.type === EventType.FullSnapshot)!;
    const root = (fullSnapshot as eventWithTime & { data: { node: SnapshotNode } }).data.node;
    const markerSnapshot = findSnapshotElement(root, "restart-marker")!;
    expect(record.mirror.getId(marker)).toBe(markerSnapshot.id);
    expect(record.mirror.isActiveNode(marker)).toBe(true);
    expect(publicMirror).toBe(record.mirror);
    expect(publicMirror.getId(marker)).toBe(markerSnapshot.id);
    expect(cachedGetId(marker)).toBe(markerSnapshot.id);
    expect(firstEvents.some((event) => event.type === EventType.FullSnapshot)).toBe(false);
  });

  it("suppresses IDs reserved by an aborted snapshot until the replacement baseline", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const target = document.createElement("button");
    target.dataset.testNode = "aborted-reservation";
    document.body.appendChild(target);
    for (let index = 0; index < 100; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    for (let frame = 0; frame < 1_000 && !record.mirror.isActiveNode(target); frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const abandonedId = record.mirror.getId(target);
    expect(abandonedId).toBeGreaterThan(0);
    expect(events.some((event) => event.type === EventType.FullSnapshot)).toBe(false);

    const largeAddition = document.createDocumentFragment();
    for (let index = 0; index < 1_001; index += 1) {
      largeAddition.appendChild(document.createElement("span"));
    }
    document.body.appendChild(largeAddition);
    await Promise.resolve();
    target.dataset.state = "changed-after-abort";
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await drainSnapshotFramesQuick(frameCallbacks, events, 5_000);

    const fullSnapshotIndex = events.findIndex((event) => event.type === EventType.FullSnapshot);
    expect(fullSnapshotIndex).toBeGreaterThan(-1);
    expect(events.filter((event) => event.type === EventType.FullSnapshot)).toHaveLength(1);
    expect(events.filter((event) => event.type === EventType.Meta).length).toBeGreaterThan(1);
    expect(
      events
        .slice(0, fullSnapshotIndex)
        .some((event) => event.type === EventType.IncrementalSnapshot),
    ).toBe(false);
    expect(record.mirror.getId(target)).not.toBe(abandonedId);
    expect(JSON.stringify(events[fullSnapshotIndex])).toContain("changed-after-abort");
  });

  it("uses sliced checkpoints for huge direct removals and shadow-root additions", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const largeRemovedTree = document.createElement("section");
    for (let index = 0; index < 1_001; index += 1)
      largeRemovedTree.appendChild(document.createElement("div"));
    document.body.appendChild(largeRemovedTree);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: 1,
    });
    await waitForFullSnapshot(events, frameCallbacks);
    const retainedRootId = record.mirror.getId(largeRemovedTree);
    const firstRemovedChildId = record.mirror.getId(largeRemovedTree.firstChild);
    const lastRemovedChildId = record.mirror.getId(largeRemovedTree.lastChild);
    const waitForNextSnapshot = async (previousCount: number) => {
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        if (events.filter((event) => event.type === EventType.FullSnapshot).length > previousCount)
          return;
        frameCallbacks.shift()?.(attempt * 16);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Large mutation checkpoint did not finish.");
    };

    const beforeRemoval = events.filter((event) => event.type === EventType.FullSnapshot).length;
    largeRemovedTree.replaceChildren();
    await waitForMutationFlush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(frameCallbacks.length).toBeGreaterThan(0);
    await waitForNextSnapshot(beforeRemoval);
    expect(record.mirror.getNode(retainedRootId)).toBeNull();
    expect(record.mirror.getId(largeRemovedTree)).toBeGreaterThan(0);
    expect(record.mirror.getNode(firstRemovedChildId)).toBeNull();
    expect(record.mirror.getNode(lastRemovedChildId)).toBeNull();

    const host = document.createElement("section");
    const shadowRoot = host.attachShadow({ mode: "open" });
    for (let index = 0; index < 1_001; index += 1)
      shadowRoot.appendChild(document.createElement("div"));
    const beforeShadowAdd = events.filter((event) => event.type === EventType.FullSnapshot).length;
    document.body.appendChild(host);
    await waitForMutationFlush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(frameCallbacks.length).toBeGreaterThan(0);
    await waitForNextSnapshot(beforeShadowAdd);
    const shadowChildId = record.mirror.getId(shadowRoot.lastChild);
    const beforeShadowRemoval = events.filter(
      (event) => event.type === EventType.FullSnapshot,
    ).length;
    host.remove();
    await waitForMutationFlush();
    await waitForNextSnapshot(beforeShadowRemoval);
    expect(record.mirror.getNode(shadowChildId)).toBeNull();
  });

  it("uses a sliced checkpoint for a bulk attribute update", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const rows = Array.from({ length: 1_001 }, (_, index) => {
      const row = document.createElement("div");
      if (index === 1_000) row.dataset.testNode = "bulk-attribute-last";
      document.body.appendChild(row);
      return row;
    });
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: 1,
    });
    await waitForFullSnapshot(events, frameCallbacks);
    const previousSnapshotCount = events.filter(
      (event) => event.type === EventType.FullSnapshot,
    ).length;
    const eventCut = events.length;

    for (const row of rows) row.setAttribute("data-state", "ready");
    await waitForMutationFlush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    for (let frame = 0; frame < 2_000; frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (
        events.filter((event) => event.type === EventType.FullSnapshot).length >
        previousSnapshotCount
      )
        break;
    }

    const nextSnapshot = events
      .slice(eventCut)
      .find((event) => event.type === EventType.FullSnapshot);
    expect(nextSnapshot).toBeDefined();
    const root = (nextSnapshot as eventWithTime & { data: { node: SnapshotNode } }).data.node;
    expect(findSnapshotElement(root, "bulk-attribute-last")?.attributes?.["data-state"]).toBe(
      "ready",
    );
    expect(
      events
        .slice(eventCut)
        .some(
          (event) =>
            event.type === EventType.IncrementalSnapshot &&
            event.data.source === IncrementalSource.Mutation &&
            event.data.attributes.length > 1_000,
        ),
    ).toBe(false);
  });

  it("drops a queued input value when its target becomes blocked", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const wrapper = document.createElement("section");
    const input = document.createElement("input");
    wrapper.appendChild(input);
    document.body.appendChild(wrapper);
    for (let index = 0; index < 60; index += 1)
      document.body.appendChild(document.createElement("div"));

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    for (let frame = 0; frame < 300 && !record.mirror.isActiveNode(input); frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(record.mirror.isActiveNode(input)).toBe(true);
    const inputId = record.mirror.getId(input);
    input.value = "queued-private-input";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    wrapper.classList.add("rr-block");
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    expect(JSON.stringify(events)).not.toContain("queued-private-input");
    expect(
      events.some(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Input &&
          event.data.id === inputId,
      ),
    ).toBe(false);
  });

  it("restarts from a fresh checkpoint when snapshot catch-up reaches its bound", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const input = document.createElement("input");
    document.body.appendChild(input);
    for (let index = 0; index < 60; index += 1)
      document.body.appendChild(document.createElement("div"));
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    for (let frame = 0; frame < 300 && !record.mirror.isActiveNode(input); frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(record.mirror.isActiveNode(input)).toBe(true);

    for (let index = 0; index < 257; index += 1) {
      input.value = `value-${index}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await drainSnapshotFrames(frameCallbacks, events);

    expect(events.filter((event) => event.type === EventType.Meta).length).toBeGreaterThan(1);
    expect(events.filter((event) => event.type === EventType.FullSnapshot)).toHaveLength(1);
  });

  it("masks text when an ancestor becomes private during a snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    for (let index = 0; index < 20; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }
    const privateArea = document.createElement("section");
    const text = document.createElement("span");
    text.textContent = "public-before-cut";
    privateArea.appendChild(text);
    document.body.appendChild(privateArea);

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    await startChunkedSnapshot(frameCallbacks);
    privateArea.classList.add("rr-mask");
    text.textContent = "private-after-cut";
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    expect(JSON.stringify(events)).not.toContain("private-after-cut");
    stopRecording?.();
    stopRecording = undefined;
  });

  it("does not capture a branch blocked during a snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    for (let index = 0; index < 20; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }
    const privateArea = document.createElement("section");
    const text = document.createElement("span");
    text.textContent = "public-before-block";
    privateArea.appendChild(text);
    document.body.appendChild(privateArea);

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    await startChunkedSnapshot(frameCallbacks);
    privateArea.classList.add("rr-block");
    text.textContent = "blocked-after-cut";
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    expect(JSON.stringify(events)).not.toContain("blocked-after-cut");
    stopRecording?.();
    stopRecording = undefined;
  });

  it("notices an escaped privacy attribute changed during a snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const privateArea = document.createElement("section");
    privateArea.textContent = "escaped-attribute-private-text";
    document.body.appendChild(privateArea);
    for (let index = 0; index < 40; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      blockSelector: "[data\\2d private]",
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    await startChunkedSnapshot(frameCallbacks);
    privateArea.setAttribute("data-private", "");
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    expect(JSON.stringify(events)).not.toContain("escaped-attribute-private-text");
  });

  it("scrubs an early serialized branch when privacy changes before emit", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const blocked = document.createElement("section");
    const blockedText = document.createTextNode("public-block-text");
    blocked.appendChild(blockedText);
    const masked = document.createElement("section");
    const maskedText = document.createTextNode("public-mask-text");
    masked.appendChild(maskedText);
    document.body.append(blocked, masked);
    for (let index = 0; index < 60; index += 1)
      document.body.appendChild(document.createElement("div"));

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    const blockedId = record.mirror.getId(blockedText);
    for (let frame = 0; frame < 200 && record.mirror.getNode(blockedId) === null; frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    blockedText.data = "private-late-block";
    maskedText.data = "private-late-mask";
    await waitForMutationFlush();
    blocked.classList.add("rr-block");
    masked.classList.add("rr-mask");
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const recorded = JSON.stringify(events);
    expect(recorded).not.toContain("private-late-block");
    expect(recorded).not.toContain("private-late-mask");
  });

  it("keeps style and script placeholders intact during a late mask", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const masked = document.createElement("section");
    const text = document.createTextNode("private-normal-text");
    const style = document.createElement("style");
    style.textContent = ".kept-style { color: red; }";
    const script = document.createElement("script");
    script.type = "application/json";
    script.textContent = "private-script-source";
    masked.append(text, style, script);
    document.body.appendChild(masked);
    for (let index = 0; index < 60; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    const textId = record.mirror.getId(text);
    for (let frame = 0; frame < 300 && record.mirror.getNode(textId) === null; frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    masked.classList.add("rr-mask");
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const recorded = JSON.stringify(events);
    expect(recorded).not.toContain("private-normal-text");
    expect(recorded).toContain("kept-style");
    expect(recorded).toContain("SCRIPT_PLACEHOLDER");
    expect(recorded).not.toContain("private-script-source");
  });

  it("honors a shadow host blocked during a snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    for (let index = 0; index < 20; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }
    const host = document.createElement("section");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const text = document.createElement("span");
    text.textContent = "public-shadow-text";
    shadowRoot.appendChild(text);
    document.body.appendChild(host);

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    await startChunkedSnapshot(frameCallbacks);
    host.classList.add("rr-block");
    text.textContent = "blocked-shadow-text";
    const added = document.createElement("strong");
    added.textContent = "blocked-shadow-addition";
    shadowRoot.appendChild(added);
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const recorded = JSON.stringify(events);
    expect(recorded).not.toContain("blocked-shadow-text");
    expect(recorded).not.toContain("blocked-shadow-addition");
    stopRecording?.();
    stopRecording = undefined;
  });

  it("honors an iframe owner blocked during a snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    for (let index = 0; index < 20; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument!;
    iframeDocument.body.textContent = "public-iframe-text";

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    await startChunkedSnapshot(frameCallbacks);
    iframe.classList.add("rr-block");
    iframeDocument.body.textContent = "blocked-iframe-text";
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    expect(JSON.stringify(events)).not.toContain("blocked-iframe-text");
    stopRecording?.();
    stopRecording = undefined;
  });

  it("masks an iframe attachment when its owner becomes private before catch-up", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    iframe.contentDocument!.body.textContent = "private-queued-iframe";
    for (let index = 0; index < 30; index += 1)
      document.body.appendChild(document.createElement("div"));
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
        if (event.type === EventType.FullSnapshot) iframe.className = "rr-mask";
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    await drainSnapshotFrames(frameCallbacks, events);

    expect(JSON.stringify(events)).not.toContain("private-queued-iframe");
    expect(iframeAttachEvents(events)).toHaveLength(1);
  });

  it("drops an iframe baseline when the document changes before attachment", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    iframe.contentDocument!.body.textContent = "stale-iframe-baseline-secret";
    for (let index = 0; index < 30; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }
    const replacementDocument = document.implementation.createHTMLDocument("replacement");
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
        if (event.type === EventType.FullSnapshot) {
          Object.defineProperty(iframe, "contentDocument", {
            configurable: true,
            get: () => replacementDocument,
          });
        }
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    await drainSnapshotFrames(frameCallbacks, events);

    expect(JSON.stringify(events)).not.toContain("stale-iframe-baseline-secret");
    expect(iframeAttachEvents(events)).toHaveLength(0);
  });

  it("keeps more than 256 iframe baselines outside the live catch-up limit", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    for (let index = 0; index < 257; index += 1) {
      document.body.appendChild(document.createElement("iframe"));
    }
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: 4,
    });

    await drainSnapshotFrames(frameCallbacks, events);

    expect(events.filter((event) => event.type === EventType.FullSnapshot)).toHaveLength(1);
    expect(iframeAttachEvents(events)).toHaveLength(257);
  });

  it("ignores a retained iframe document after its owner changes documents", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const oldDocument = iframe.contentDocument!;
    const input = oldDocument.createElement("input");
    oldDocument.body.appendChild(input);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      maskAllInputs: true,
      recordAfter: "DOMContentLoaded",
    });
    await waitForFullSnapshot(events);
    const replacementDocument = document.implementation.createHTMLDocument("replacement");
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => replacementDocument,
    });
    input.value = "detached-private-input";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const secret = oldDocument.createElement("div");
    secret.textContent = "detached-private-node";
    oldDocument.body.appendChild(secret);
    await waitForMutationFlush();

    expect(JSON.stringify(events)).not.toContain("detached-private");
  });

  it("masks text across shadow and iframe boundaries during a snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    for (let index = 0; index < 20; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }
    const host = document.createElement("section");
    const shadowText = document.createElement("span");
    host.attachShadow({ mode: "open" }).appendChild(shadowText);
    const iframe = document.createElement("iframe");
    document.body.append(host, iframe);
    const iframeText = iframe.contentDocument!.createElement("span");
    iframe.contentDocument!.body.appendChild(iframeText);

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    await startChunkedSnapshot(frameCallbacks);
    host.classList.add("rr-mask");
    iframe.classList.add("rr-mask");
    shadowText.textContent = "private-shadow-boundary";
    iframeText.textContent = "private-iframe-boundary";
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const recorded = JSON.stringify(events);
    expect(recorded).not.toContain("private-shadow-boundary");
    expect(recorded).not.toContain("private-iframe-boundary");
    stopRecording?.();
    stopRecording = undefined;
  });

  it("keeps a moved shadow observer and releases it after removal", async () => {
    const source = document.createElement("section");
    const target = document.createElement("section");
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).appendChild(document.createElement("span"));
    source.appendChild(host);
    document.body.append(source, target);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
    });
    await waitForFullSnapshot(events);
    const observerCount = mutationBuffers.length;
    expect(observerCount).toBeGreaterThan(1);

    target.appendChild(host);
    await waitForMutationFlush();
    expect(mutationBuffers).toHaveLength(observerCount);

    host.remove();
    await waitForMutationFlush();
    expect(mutationBuffers).toHaveLength(observerCount - 1);
  });

  it("keeps shadow removals consistent during a snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    for (let index = 0; index < 20; index += 1) {
      document.body.appendChild(document.createElement("div"));
    }
    const host = document.createElement("section");
    host.dataset.testNode = "shadow-host";
    const shadowRoot = host.attachShadow({ mode: "open" });
    const removed = document.createElement("span");
    removed.dataset.testNode = "shadow-removed";
    removed.textContent = "inside shadow root";
    shadowRoot.appendChild(removed);
    document.body.appendChild(host);

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    await startChunkedSnapshot(frameCallbacks);
    removed.remove();
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const fullSnapshotIndex = events.findIndex((event) => event.type === EventType.FullSnapshot);
    const fullSnapshot = events[fullSnapshotIndex]!;
    const root = (fullSnapshot as eventWithTime & { data: { node: SnapshotNode } }).data.node;
    const removedNode = findSnapshotElement(root, "shadow-removed");
    const laterMutations = events
      .slice(fullSnapshotIndex + 1)
      .filter(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation,
      );
    if (removedNode !== undefined) {
      expect(removedNode.isShadow).toBe(true);
      expect(JSON.stringify(laterMutations)).toContain(`"id":${removedNode.id}`);
    } else {
      expect(JSON.stringify(laterMutations)).not.toContain("shadow-removed");
    }

    stopRecording?.();
    stopRecording = undefined;
  });

  it("captures a loaded iframe in slices before its queued mutations", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument!;
    iframeDocument.open();
    iframeDocument.write("<!doctype html><html><body></body></html>");
    iframeDocument.close();
    for (let index = 0; index < 20; index += 1) {
      iframeDocument.body.appendChild(iframeDocument.createElement("div"));
    }
    const removed = iframeDocument.createElement("span");
    removed.dataset.testNode = "iframe-removed";
    removed.textContent = "inside iframe";
    iframeDocument.body.appendChild(removed);

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });

    await startChunkedSnapshot(frameCallbacks);
    removed.remove();
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    // The player sorts persisted events by timestamp before replaying them.
    const replayOrder = [...events].sort((left, right) => left.timestamp - right.timestamp);
    const fullSnapshotIndex = replayOrder.findIndex(
      (event) => event.type === EventType.FullSnapshot,
    );
    const iframeAttachIndex = replayOrder.findIndex(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation &&
        event.data.isAttachIframe === true,
    );
    expect(iframeAttachIndex).toBeGreaterThan(fullSnapshotIndex);
    const iframeAttach = replayOrder[iframeAttachIndex]!;
    const iframeSnapshot = (
      iframeAttach as eventWithTime & {
        data: { adds: Array<{ node: SnapshotNode }> };
      }
    ).data.adds[0]!.node;
    const removedNode = findSnapshotElement(iframeSnapshot, "iframe-removed");
    const laterMutations = replayOrder
      .slice(iframeAttachIndex + 1)
      .filter(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation,
      );
    if (removedNode !== undefined) {
      expect(JSON.stringify(laterMutations)).toContain(`"id":${removedNode.id}`);
    } else {
      expect(JSON.stringify(laterMutations)).not.toContain("iframe-removed");
    }

    stopRecording?.();
    stopRecording = undefined;
  });

  it("serializes iframe baselines as ordered parts behind the capacity hook", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const firstIframe = document.createElement("iframe");
    const parentIframe = document.createElement("iframe");
    document.body.append(firstIframe, parentIframe);
    firstIframe.contentDocument!.body.textContent = "first-frame-part";
    parentIframe.contentDocument!.body.textContent = "parent-frame-part";
    const nestedIframe = parentIframe.contentDocument!.createElement("iframe");
    parentIframe.contentDocument!.body.appendChild(nestedIframe);
    nestedIframe.contentDocument!.body.textContent = "nested-frame-part";

    const preparedParts: Array<number | undefined> = [];
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
      prepareForSnapshotPart: async (nextBytes) => {
        preparedParts.push(nextBytes);
      },
    });

    await waitForIframeAttachments(frameCallbacks, events, 3);

    const fullSnapshot = events.find((event) => event.type === EventType.FullSnapshot);
    expect(JSON.stringify(fullSnapshot)).not.toContain("frame-part");
    const attachments = iframeAttachEvents(events);
    expect(attachments).toHaveLength(3);
    expect(JSON.stringify(attachments[0])).toContain("first-frame-part");
    expect(JSON.stringify(attachments[1])).toContain("parent-frame-part");
    expect(JSON.stringify(attachments[2])).toContain("nested-frame-part");
    expect(preparedParts).toHaveLength(8);
    for (let index = 0; index < preparedParts.length; index += 2) {
      expect(preparedParts[index]).toBeUndefined();
      expect(preparedParts[index + 1]).toBeGreaterThan(0);
    }
  });

  it("drops a stale iframe while it waits for snapshot capacity", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    iframe.contentDocument!.body.textContent = "stale-waiting-frame";

    let releaseCapacity = () => undefined;
    const capacity = new Promise<void>((resolve) => {
      releaseCapacity = resolve;
    });
    let waitingForIframeCapacity = false;
    let prepareCallCount = 0;
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
      prepareForSnapshotPart: async (nextBytes) => {
        prepareCallCount += 1;
        if (prepareCallCount === 3 && nextBytes === undefined) {
          waitingForIframeCapacity = true;
          await capacity;
        }
      },
    });

    for (let frame = 0; frame < 1_000 && !waitingForIframeCapacity; frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(waitingForIframeCapacity).toBe(true);
    iframe.remove();
    releaseCapacity();
    for (let frame = 0; frame < 20; frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(events.filter((event) => event.type === EventType.FullSnapshot)).toHaveLength(1);
    expect(iframeAttachEvents(events)).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("stale-waiting-frame");
  });

  it("drains main-page events after a queued iframe becomes stale", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const firstIframe = document.createElement("iframe");
    const staleIframe = document.createElement("iframe");
    const button = document.createElement("button");
    document.body.append(firstIframe, staleIframe, button);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    await drainSnapshotFrames(frameCallbacks, events);
    const firstSnapshotCount = events.filter(
      (event) => event.type === EventType.FullSnapshot,
    ).length;

    const firstReload = document.implementation.createHTMLDocument("First reload");
    const staleReload = document.implementation.createHTMLDocument("Stale reload");
    Object.defineProperty(firstReload, "readyState", { value: "complete" });
    Object.defineProperty(staleReload, "readyState", { value: "complete" });
    for (let index = 0; index < 30; index += 1) {
      firstReload.body.appendChild(firstReload.createElement("div"));
      staleReload.body.appendChild(staleReload.createElement("div"));
    }
    Object.defineProperty(firstIframe, "contentDocument", {
      configurable: true,
      get: () => firstReload,
    });
    Object.defineProperty(staleIframe, "contentDocument", {
      configurable: true,
      get: () => staleReload,
    });
    firstIframe.dispatchEvent(new Event("load"));
    staleIframe.dispatchEvent(new Event("load"));
    staleIframe.remove();
    button.dataset.state = "after-stale-iframe";
    await waitForMutationFlush();

    for (let frame = 0; frame < 1_000; frame += 1) {
      if (JSON.stringify(events).includes("after-stale-iframe")) break;
      frameCallbacks.shift()?.(frame * 16);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(events.filter((event) => event.type === EventType.FullSnapshot)).toHaveLength(
      firstSnapshotCount,
    );
    expect(JSON.stringify(events)).toContain("after-stale-iframe");
  });

  it("snapshots a reloaded iframe without checking out the whole page", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: 1,
    });
    await waitForFullSnapshot(events);
    await waitForMutationFlush();
    const fullSnapshotCount = events.filter(
      (event) => event.type === EventType.FullSnapshot,
    ).length;
    const initialAttachCount = iframeAttachEvents(events).length;
    iframe.classList.add("rr-mask");

    const reloadedDocument = document.implementation.createHTMLDocument("Reloaded");
    Object.defineProperty(reloadedDocument, "readyState", { value: "complete" });
    const reloadedText = reloadedDocument.createElement("p");
    reloadedText.textContent = "iframe-reloaded-without-page-checkout";
    reloadedDocument.body.appendChild(reloadedText);
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => reloadedDocument,
    });
    iframe.dispatchEvent(new Event("load"));

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (iframeAttachEvents(events).length > initialAttachCount) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(events.filter((event) => event.type === EventType.FullSnapshot)).toHaveLength(
      fullSnapshotCount,
    );
    const latestAttach = iframeAttachEvents(events).at(-1);
    expect(JSON.stringify(latestAttach)).not.toContain("iframe-reloaded-without-page-checkout");
    stopRecording?.();
    stopRecording = undefined;
  });

  it("attaches a reloaded iframe before all 64 nested iframe baselines", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    await drainSnapshotFrames(frameCallbacks, events);
    const initialAttachCount = iframeAttachEvents(events).length;
    const initialSnapshotCount = events.filter(
      (event) => event.type === EventType.FullSnapshot,
    ).length;

    const replacement = document.implementation.createHTMLDocument("nested reload");
    Object.defineProperty(replacement, "readyState", { value: "complete" });
    for (let index = 0; index < 64; index += 1) {
      const nestedIframe = replacement.createElement("iframe");
      const nestedDocument = document.implementation.createHTMLDocument(`nested ${index}`);
      Object.defineProperty(nestedDocument, "readyState", { value: "complete" });
      nestedDocument.body.textContent = `nested-iframe-${index}`;
      Object.defineProperty(nestedIframe, "contentDocument", {
        configurable: true,
        get: () => nestedDocument,
      });
      Object.defineProperty(nestedIframe, "contentWindow", {
        configurable: true,
        get: () => iframe.contentWindow,
      });
      replacement.body.appendChild(nestedIframe);
    }
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => replacement,
    });
    iframe.dispatchEvent(new Event("load"));

    for (let frame = 0; frame < 5_000; frame += 1) {
      if (iframeAttachEvents(events).length >= initialAttachCount + 65) break;
      frameCallbacks.shift()?.(frame * 16);
      if (frame % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      else await Promise.resolve();
    }

    expect(iframeAttachEvents(events)).toHaveLength(initialAttachCount + 65);
    expect(events.filter((event) => event.type === EventType.FullSnapshot)).toHaveLength(
      initialSnapshotCount,
    );
    expect(JSON.stringify(events)).toContain("nested-iframe-63");
  });

  it("does not observe a blocked iframe document", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const iframe = document.createElement("iframe");
    iframe.className = "rr-block";
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument!;
    iframeDocument.open();
    iframeDocument.write("<!doctype html><html><body><p>blocked-before-cut</p></body></html>");
    iframeDocument.close();

    const events: eventWithTime[] = [];
    stopRecording = record({
      emit(event) {
        events.push(event);
      },
      recordAfter: "DOMContentLoaded",
      snapshotTimeSliceMs: Number.MIN_VALUE,
    });
    await startChunkedSnapshot(frameCallbacks);
    iframeDocument.body.textContent = "blocked-after-cut";
    await waitForMutationFlush();
    await drainSnapshotFrames(frameCallbacks, events);

    const recorded = JSON.stringify(events);
    expect(recorded).not.toContain("blocked-before-cut");
    expect(recorded).not.toContain("blocked-after-cut");
    expect(record.mirror.getId(iframeDocument.body)).toBe(-1);

    stopRecording?.();
    stopRecording = undefined;
  });
});

describe("Mirror topology reservations", () => {
  it("tracks one visit per capture without exposing the private marker", () => {
    const mirror = new Mirror();
    const reservedNode = document.createElement("div");
    let nextId = 41;

    mirror.startIdReservation(() => nextId++);
    mirror.startTopologyCapture();
    expect(mirror.getId(reservedNode)).toBe(41);
    expect(mirror.activateReservation(reservedNode)).toBe(true);
    expect(mirror.activateReservation(reservedNode)).toBe(false);
    expect(mirror.hasActiveReservationForCurrentGeneration(reservedNode)).toBe(true);
    expect(Object.entries(mirror.getMeta(reservedNode)!)).toEqual([["id", 41]]);
    expect(JSON.stringify(mirror.getMeta(reservedNode))).toBe('{"id":41}');

    mirror.stopIdReservation();
    expect(mirror.isActiveNode(reservedNode)).toBe(true);

    mirror.startIdReservation(() => nextId++);
    mirror.startTopologyCapture();
    expect(mirror.hasActiveReservationForCurrentGeneration(reservedNode)).toBe(false);
    expect(mirror.activateReservation(reservedNode)).toBe(true);

    const unseenNode = document.createElement("div");
    expect(mirror.hasNode(unseenNode)).toBe(false);
    expect(mirror.hasActiveReservationForCurrentGeneration(unseenNode)).toBe(false);
    expect(mirror.hasNode(unseenNode)).toBe(false);
    expect(mirror.getId(unseenNode)).toBe(42);
    expect(mirror.activateReservation(unseenNode)).toBe(true);

    const committedMeta = { id: 41 } as Parameters<Mirror["add"]>[1];
    mirror.updateMeta(reservedNode, committedMeta);
    expect(mirror.hasActiveReservationForCurrentGeneration(reservedNode)).toBe(true);
    mirror.add(reservedNode, committedMeta);
    expect(mirror.hasActiveReservationForCurrentGeneration(reservedNode)).toBe(true);
    expect(mirror.activateReservation(reservedNode)).toBe(false);
    mirror.stopIdReservation();

    mirror.startIdReservation(() => nextId++);
    mirror.startTopologyCapture();
    expect(mirror.getId(reservedNode)).toBe(41);
    expect(mirror.activateReservation(reservedNode)).toBe(true);
    mirror.stopIdReservation();

    mirror.reset();
    expect(mirror.isActiveNode(reservedNode)).toBe(false);
  });
});

describe("snapshotInChunks", () => {
  it("deduplicates topology repair scans without a live mirror", async () => {
    const first = document.createElement("div");
    first.dataset.topologyRepair = "first";
    const second = document.createElement("div");
    second.dataset.topologyRepair = "second";
    document.body.append(first, second);
    const serializedMarkers: string[] = [];
    let topologyRevision = 0;
    let revisionChanged = false;
    let clock = 0;

    const result = await snapshotInChunks(
      document,
      {
        mirror: new Mirror(),
        onSerialize: (node) => {
          if (node instanceof HTMLElement && node.dataset.topologyRepair !== undefined) {
            serializedMarkers.push(node.dataset.topologyRepair);
          }
        },
      },
      {
        skipPreparation: true,
        timeSliceMs: Number.MIN_VALUE,
        now: () => clock++,
        getTopologyRevision: () => topologyRevision,
        yieldToMain: async () => {
          if (!revisionChanged) {
            revisionChanged = true;
            topologyRevision += 1;
          }
        },
      },
    );

    expect(result).not.toBeNull();
    expect(revisionChanged).toBe(true);
    expect(serializedMarkers.filter((marker) => marker === "first")).toHaveLength(1);
    expect(serializedMarkers.filter((marker) => marker === "second")).toHaveLength(1);
  });

  it("captures a new iframe document found during topology repair", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const initialDocument = iframe.contentDocument!;
    Object.defineProperty(initialDocument, "readyState", { value: "complete" });
    initialDocument.body.textContent = "initial-iframe-document";
    const replacementDocument = document.implementation.createHTMLDocument("replacement");
    Object.defineProperty(replacementDocument, "readyState", { value: "complete" });
    replacementDocument.body.textContent = "replacement-found-during-repair";
    let currentDocument = initialDocument;
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => currentDocument,
    });

    const registeredDocuments: Document[] = [];
    const loadedDocuments: Array<{ document: Document; snapshot: unknown }> = [];
    const liveMirror = new Mirror();
    let nextId = 1;
    let topologyRevision = 0;
    let initialDocumentRegistered = false;
    let documentChanged = false;
    let clock = 0;
    liveMirror.startIdReservation(() => nextId++);

    const result = await snapshotInChunks(
      document,
      {
        mirror: new Mirror(),
        reuseIdsFrom: liveMirror,
        onIframeLoad: (_iframe, snapshotNode, capturedDocument) => {
          if (capturedDocument !== undefined) {
            loadedDocuments.push({ document: capturedDocument, snapshot: snapshotNode });
          }
        },
      },
      {
        skipPreparation: true,
        timeSliceMs: Number.MIN_VALUE,
        now: () => clock++,
        getTopologyRevision: () => topologyRevision,
        onIframeDocument: (_iframe, capturedDocument) => {
          registeredDocuments.push(capturedDocument);
          if (capturedDocument === initialDocument) initialDocumentRegistered = true;
        },
        yieldToMain: async () => {
          if (initialDocumentRegistered && !documentChanged) {
            currentDocument = replacementDocument;
            documentChanged = true;
            topologyRevision += 1;
          }
        },
      },
    );
    liveMirror.stopIdReservation();

    expect(result).not.toBeNull();
    expect(documentChanged).toBe(true);
    expect(registeredDocuments).toEqual([initialDocument, replacementDocument]);
    expect(loadedDocuments.map((loaded) => loaded.document)).toEqual([replacementDocument]);
    expect(JSON.stringify(loadedDocuments[0]?.snapshot)).toContain(
      "replacement-found-during-repair",
    );
  });

  it("masks text that is a direct child of a shadow root", async () => {
    const host = document.createElement("section");
    host.className = "rr-mask";
    host.attachShadow({ mode: "open" }).appendChild(document.createTextNode("shadow-secret"));
    document.body.appendChild(host);

    const result = await snapshotInChunks(
      document,
      { mirror: new Mirror() },
      { skipPreparation: true },
    );

    expect(JSON.stringify(result)).not.toContain("shadow-secret");
  });

  it("keeps detached script text private after the topology cut", async () => {
    const script = document.createElement("script");
    script.textContent = "/* private-detached-script */";
    document.body.appendChild(script);

    const result = await snapshotInChunks(
      document,
      { mirror: new Mirror() },
      {
        skipPreparation: true,
        afterTopology: () => script.remove(),
      },
    );

    expect(JSON.stringify(result)).toContain("SCRIPT_PLACEHOLDER");
    expect(JSON.stringify(result)).not.toContain("private-detached-script");
  });

  it("keeps captured-parent masking after a child moves to a public branch", async () => {
    const privateParent = document.createElement("section");
    const movedText = document.createElement("span");
    movedText.textContent = "public-before-topology";
    privateParent.appendChild(movedText);
    const publicParent = document.createElement("section");
    document.body.append(privateParent, publicParent);
    let privacyRevision = 0;

    const result = await snapshotInChunks(
      document,
      { mirror: new Mirror() },
      {
        skipPreparation: true,
        getPrivacyRevision: () => privacyRevision,
        afterTopology: () => {
          privateParent.className = "rr-mask";
          publicParent.appendChild(movedText);
          movedText.textContent = "private-after-topology";
          privacyRevision += 1;
        },
      },
    );

    expect(JSON.stringify(result)).not.toContain("private-after-topology");
  });

  it("fails closed when privacy keeps changing during the final pass", async () => {
    const last = document.createElement("span");
    const lastText = document.createTextNode("unstable-private-text");
    last.appendChild(lastText);
    document.body.appendChild(last);
    let privacyRevision = 0;
    let lastNodeSerialized = false;
    let clock = 0;
    const onSnapshotUnstable = vi.fn();

    const result = await snapshotInChunks(
      document,
      {
        mirror: new Mirror(),
        onSerialize: (node) => {
          if (node === lastText) lastNodeSerialized = true;
        },
      },
      {
        skipPreparation: true,
        timeSliceMs: 1,
        now: () => clock++,
        getPrivacyRevision: () => privacyRevision,
        onSnapshotUnstable,
        yieldToMain: async () => {
          if (lastNodeSerialized) privacyRevision += 1;
        },
      },
    );

    expect(result).toBeNull();
    expect(onSnapshotUnstable).toHaveBeenCalledOnce();
  });

  it("fails closed when privacy changes while iframe snapshots are finalized", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument!;
    Object.defineProperty(iframeDocument, "readyState", { value: "complete" });
    iframeDocument.body.textContent = "iframe-content";
    let privacyRevision = 0;
    let iframeSnapshotFinalizing = false;
    let privacyChanged = false;
    let clock = 0;
    const onSnapshotUnstable = vi.fn();

    const result = await snapshotInChunks(
      document,
      {
        mirror: new Mirror(),
        onIframeLoad: () => {
          iframeSnapshotFinalizing = true;
        },
      },
      {
        skipPreparation: true,
        timeSliceMs: 1,
        now: () => clock++,
        getPrivacyRevision: () => privacyRevision,
        onSnapshotUnstable,
        yieldToMain: async () => {
          if (iframeSnapshotFinalizing && !privacyChanged) {
            privacyChanged = true;
            privacyRevision += 1;
          }
        },
      },
    );

    expect(iframeSnapshotFinalizing).toBe(true);
    expect(result).toBeNull();
    expect(onSnapshotUnstable).toHaveBeenCalledOnce();
  });

  it("keeps image sources for the public synchronous snapshot API", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const image = document.createElement("img");
    image.src = "/direct-snapshot.png";
    document.body.appendChild(image);

    const result = snapshot(document, { mirror: new Mirror(), inlineImages: true });

    expect(JSON.stringify(result)).toContain("/direct-snapshot.png");
  });

  it("matches the synchronous snapshot across topology storage chunks", async () => {
    for (let index = 0; index < 520; index += 1) {
      const row = document.createElement("div");
      row.dataset.index = String(index);
      row.textContent = `item-${index}`;
      document.body.appendChild(row);
    }

    cleanupSnapshot();
    const expected = snapshot(document, { mirror: new Mirror(), maskAllInputs: true });
    cleanupSnapshot();
    let clock = 0;
    const yieldToMain = vi.fn(async () => undefined);
    const result = await snapshotInChunks(
      document,
      { mirror: new Mirror(), maskAllInputs: true },
      {
        timeSliceMs: 4,
        now: () => clock++,
        yieldToMain,
      },
    );

    expect(result).toEqual(expected);
    expect(yieldToMain).toHaveBeenCalled();
  });

  it("keeps public parent and sibling positions exact across topology chunks", async () => {
    const siblings = Array.from({ length: 1_050 }, (_, index) => {
      const child = document.createElement("div");
      child.dataset.index = String(index);
      document.body.appendChild(child);
      return child;
    });
    const liveMirror = new Mirror();
    let nextId = 1;
    liveMirror.startIdReservation(() => nextId++);
    let capturedIds: readonly number[] = [];
    let parentIndexes: readonly number[] = [];
    let nextIds: readonly (number | null)[] = [];

    const result = await snapshotInChunks(
      document,
      { mirror: new Mirror(), reuseIdsFrom: liveMirror },
      {
        skipPreparation: true,
        now: () => 0,
        yieldToMain: async () => undefined,
        afterTopology: (ids, parents, nextSiblings) => {
          capturedIds = ids;
          parentIndexes = parents;
          nextIds = nextSiblings;
        },
      },
    );
    liveMirror.stopIdReservation();

    expect(result).not.toBeNull();
    expect(Array.isArray(capturedIds)).toBe(true);
    expect(Array.isArray(parentIndexes)).toBe(true);
    expect(Array.isArray(nextIds)).toBe(true);
    const positionById = new Map(capturedIds.map((id, index) => [id, index]));
    const bodyIndex = positionById.get(liveMirror.getId(document.body));
    let crossingSibling = -1;
    for (let index = 0; index + 1 < siblings.length; index += 1) {
      const currentPosition = positionById.get(liveMirror.getId(siblings[index]!));
      const nextPosition = positionById.get(liveMirror.getId(siblings[index + 1]!));
      if (
        currentPosition !== undefined &&
        nextPosition !== undefined &&
        Math.floor(currentPosition / 1_024) !== Math.floor(nextPosition / 1_024)
      ) {
        crossingSibling = index;
        break;
      }
    }

    expect(bodyIndex).toBeDefined();
    expect(crossingSibling).toBeGreaterThanOrEqual(0);
    const currentId = liveMirror.getId(siblings[crossingSibling]!);
    const followingId = liveMirror.getId(siblings[crossingSibling + 1]!);
    const currentPosition = positionById.get(currentId)!;
    expect(parentIndexes[currentPosition]).toBe(bodyIndex);
    expect(nextIds[currentPosition]).toBe(followingId);
  });

  it("reuses privacy results instead of rewalking every ancestor in a deep tree", async () => {
    let parent: Element = document.body;
    for (let index = 0; index < 1_000; index += 1) {
      const child = document.createElement("div");
      parent.appendChild(child);
      parent = child;
    }
    parent.textContent = "deep-leaf";
    const contains = vi.spyOn(DOMTokenList.prototype, "contains");

    const result = await snapshotInChunks(
      document,
      { mirror: new Mirror(), blockSelector: "[data-orange-block]" },
      {
        skipPreparation: true,
        getPrivacyRevision: () => 0,
        now: () => 0,
        yieldToMain: async () => undefined,
      },
    );

    expect(JSON.stringify(result)).toContain("deep-leaf");
    expect(contains.mock.calls.length).toBeLessThan(20_000);
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
      mirror: { getId: () => 12, isActiveNode: () => true } as unknown as Mirror,
      sampling: 2,
      dataURLOptions: { type: "image/webp", quality: 0.62 },
    });
    manager.trackCanvas(canvas);

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

  it("drops a delayed frame when the canvas becomes blocked", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    let finishBlob: BlobCallback | undefined;
    const canvas = document.createElement("canvas");
    canvas.width = 20;
    canvas.height = 20;
    canvas.toBlob = (callback) => {
      finishBlob = callback;
    };
    document.body.appendChild(canvas);
    const mutation = vi.fn();
    const manager = new CanvasManager({
      recordCanvas: true,
      mutationCb: mutation,
      win: window,
      blockClass: "rr-block",
      blockSelector: null,
      mirror: { getId: () => 12, isActiveNode: () => true } as unknown as Mirror,
    });
    manager.trackCanvas(canvas);
    frameCallbacks.shift()?.(1_000);
    canvas.className = "rr-block";
    finishBlob?.(new Blob([new Uint8Array([1])], { type: "image/webp" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mutation).not.toHaveBeenCalled();
    manager.reset();
  });

  it("starts at most one canvas encoder per capture tick", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const encode = vi.fn((callback: BlobCallback) => {
      callback(new Blob([new Uint8Array([1])], { type: "image/webp" }));
    });
    const canvases = Array.from({ length: 20 }, () => {
      const canvas = document.createElement("canvas");
      canvas.width = 20;
      canvas.height = 20;
      canvas.toBlob = encode;
      document.body.appendChild(canvas);
      return canvas;
    });
    const manager = new CanvasManager({
      recordCanvas: true,
      mutationCb: vi.fn(),
      win: window,
      blockClass: "rr-block",
      blockSelector: null,
      mirror: { getId: () => 12, isActiveNode: () => true } as unknown as Mirror,
    });
    for (const canvas of canvases) manager.trackCanvas(canvas);

    frameCallbacks.shift()?.(1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(encode).toHaveBeenCalledOnce();
    manager.reset();
  });

  it("does not retain canvases when capture is disabled", () => {
    const manager = new CanvasManager({
      recordCanvas: false,
      mutationCb: vi.fn(),
      win: window,
      blockClass: "rr-block",
      blockSelector: null,
      mirror: new Mirror(),
    });
    manager.trackCanvas(document.createElement("canvas"));

    expect(
      (manager as unknown as { trackedCanvases: Set<HTMLCanvasElement> }).trackedCanvases.size,
    ).toBe(0);
  });
});

describe("ImageManager", () => {
  it("releases an unloaded image listener and can track it after reinsertion", () => {
    const container = document.createElement("section");
    const image = document.createElement("img");
    Object.defineProperty(image, "complete", { configurable: true, value: false });
    container.appendChild(image);
    document.body.appendChild(container);
    const manager = new ImageManager({
      inlineImages: true,
      mutationCb: vi.fn(),
      win: window,
      blockClass: "rr-block",
      blockSelector: null,
      mirror: new Mirror(),
    });
    const state = manager as unknown as {
      waitingImages: Map<HTMLImageElement, () => void>;
    };
    manager.trackImage(image);
    expect(state.waitingImages.size).toBe(1);

    container.remove();
    manager.removeContainedImages([container]);
    expect(state.waitingImages.size).toBe(0);

    document.body.appendChild(container);
    manager.trackImage(image);
    expect(state.waitingImages.size).toBe(1);
    manager.reset();
    expect(state.waitingImages.size).toBe(0);
  });

  it("requeues an image loaded inside a same-origin iframe", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeWindow = iframe.contentWindow as Window & typeof globalThis;
    vi.spyOn(iframeWindow.HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(iframeWindow.HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob([new Uint8Array([1])], { type: "image/webp" }));
    });
    const image = iframe.contentDocument!.createElement("img");
    iframe.contentDocument!.body.appendChild(image);
    let loaded = false;
    Object.defineProperties(image, {
      complete: { configurable: true, get: () => loaded },
      naturalWidth: { configurable: true, value: 1 },
      naturalHeight: { configurable: true, value: 1 },
    });
    const mutation = vi.fn();
    const manager = new ImageManager({
      inlineImages: true,
      mutationCb: mutation,
      win: window,
      blockClass: "rr-block",
      blockSelector: null,
      mirror: { getId: () => 14, isActiveNode: () => true } as unknown as Mirror,
    });
    manager.trackImage(image);
    loaded = true;
    image.dispatchEvent(new Event("load"));
    frameCallbacks.shift()?.(1_000);
    for (let attempt = 0; attempt < 20 && mutation.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(mutation).toHaveBeenCalledTimes(1);
    manager.reset();
  });

  it("drops delayed pixels when the image becomes blocked", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    let finishBlob: BlobCallback | undefined;
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      finishBlob = callback;
    });
    const image = document.createElement("img");
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 1 },
      naturalHeight: { configurable: true, value: 1 },
    });
    document.body.appendChild(image);
    const mutation = vi.fn();
    const manager = new ImageManager({
      inlineImages: true,
      mutationCb: mutation,
      win: window,
      blockClass: "rr-block",
      blockSelector: null,
      mirror: { getId: () => 14, isActiveNode: () => true } as unknown as Mirror,
    });
    manager.trackImage(image);
    frameCallbacks.shift()?.(1_000);
    image.className = "rr-block";
    finishBlob?.(new Blob([new Uint8Array([1])], { type: "image/webp" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mutation).not.toHaveBeenCalled();
    manager.reset();
  });
});

describe("adopted stylesheet observer", () => {
  it("records a shared constructed sheet only while an allowed adopter remains", () => {
    const blockedHost = document.createElement("div").attachShadow({ mode: "open" });
    const publicHost = document.createElement("div").attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    let publicHostAllowed = true;
    const adoptedStyleSheetCb = vi.fn();
    const stylesheetManager = new StylesheetManager({
      mutationCb: vi.fn(),
      adoptedStyleSheetCb,
    });

    stylesheetManager.adoptStyleSheets([sheet], 1, {
      host: blockedHost,
      shouldRecord: () => false,
    });
    expect(stylesheetManager.prepareAdoptedSheetMutation(sheet)).toBe(false);
    expect(adoptedStyleSheetCb).not.toHaveBeenCalled();

    stylesheetManager.adoptStyleSheets([sheet], 2, {
      host: publicHost,
      shouldRecord: () => publicHostAllowed,
    });
    expect(stylesheetManager.prepareAdoptedSheetMutation(sheet)).toBe(true);
    expect(adoptedStyleSheetCb).toHaveBeenCalledTimes(1);

    publicHostAllowed = false;
    expect(stylesheetManager.prepareAdoptedSheetMutation(sheet)).toBe(false);

    publicHostAllowed = true;
    stylesheetManager.removeAdopter(publicHost);
    expect(stylesheetManager.prepareAdoptedSheetMutation(sheet)).toBe(false);
  });

  it("resolves the document ID when the stylesheet changes after startup", () => {
    const prototype = window.Document.prototype;
    const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, "adoptedStyleSheets");
    let currentSheets: CSSStyleSheet[] = [];
    Object.defineProperty(prototype, "adoptedStyleSheets", {
      configurable: true,
      get: () => currentSheets,
      set: (sheets: CSSStyleSheet[]) => {
        currentSheets = sheets;
      },
    });
    const mirror = new Mirror();
    const stylesheetManager = new StylesheetManager({
      mutationCb: vi.fn(),
      adoptedStyleSheetCb: vi.fn(),
    });
    const adoptStyleSheets = vi
      .spyOn(stylesheetManager, "adoptStyleSheets")
      .mockImplementation(() => undefined);
    const cleanup = initAdoptedStyleSheetObserver({ mirror, stylesheetManager }, document);
    const sheet = {} as CSSStyleSheet;

    try {
      document.adoptedStyleSheets = [sheet];
      expect(adoptStyleSheets).toHaveBeenCalledWith(
        [sheet],
        -1,
        expect.objectContaining({ host: document, shouldRecord: expect.any(Function) }),
      );

      mirror.add(document, { type: NodeType.Document, id: 1, childNodes: [] });
      adoptStyleSheets.mockClear();
      document.adoptedStyleSheets = [sheet];
      expect(adoptStyleSheets).toHaveBeenCalledWith(
        [sheet],
        1,
        expect.objectContaining({ host: document, shouldRecord: expect.any(Function) }),
      );
    } finally {
      cleanup();
      Reflect.deleteProperty(document, "adoptedStyleSheets");
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(prototype, "adoptedStyleSheets");
      } else {
        Object.defineProperty(prototype, "adoptedStyleSheets", originalDescriptor);
      }
    }
  });

  it("resolves the shadow host ID when the stylesheet changes after startup", () => {
    const prototype = window.ShadowRoot.prototype;
    const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, "adoptedStyleSheets");
    let currentSheets: CSSStyleSheet[] = [];
    Object.defineProperty(prototype, "adoptedStyleSheets", {
      configurable: true,
      get: () => currentSheets,
      set: (sheets: CSSStyleSheet[]) => {
        currentSheets = sheets;
      },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    const mirror = new Mirror();
    const stylesheetManager = new StylesheetManager({
      mutationCb: vi.fn(),
      adoptedStyleSheetCb: vi.fn(),
    });
    const adoptStyleSheets = vi
      .spyOn(stylesheetManager, "adoptStyleSheets")
      .mockImplementation(() => undefined);
    const cleanup = initAdoptedStyleSheetObserver({ mirror, stylesheetManager }, shadowRoot);
    const sheet = {} as CSSStyleSheet;

    try {
      shadowRoot.adoptedStyleSheets = [sheet];
      expect(adoptStyleSheets).toHaveBeenCalledWith(
        [sheet],
        -1,
        expect.objectContaining({ host: shadowRoot, shouldRecord: expect.any(Function) }),
      );

      mirror.add(host, {
        type: NodeType.Element,
        id: 2,
        tagName: "div",
        attributes: {},
        childNodes: [],
      });
      adoptStyleSheets.mockClear();
      shadowRoot.adoptedStyleSheets = [sheet];
      expect(adoptStyleSheets).toHaveBeenCalledWith(
        [sheet],
        2,
        expect.objectContaining({ host: shadowRoot, shouldRecord: expect.any(Function) }),
      );
    } finally {
      cleanup();
      Reflect.deleteProperty(shadowRoot, "adoptedStyleSheets");
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(prototype, "adoptedStyleSheets");
      } else {
        Object.defineProperty(prototype, "adoptedStyleSheets", originalDescriptor);
      }
    }
  });
});

describe("IframeManager", () => {
  it("does not enumerate every removed node after a large mutation is detected", () => {
    const buffer = new MutationBuffer();
    const onLargeMutation = vi.fn();
    Object.assign(buffer as unknown as { largeMutationCb: () => void }, {
      largeMutationCb: onLargeMutation,
    });
    const removedNodes = new Proxy(
      { length: 1_001 },
      {
        get(target, property, receiver) {
          if (property === Symbol.iterator) throw new Error("removed nodes were enumerated");
          return Reflect.get(target, property, receiver);
        },
      },
    );

    buffer.processMutations([
      {
        type: "childList",
        addedNodes: { length: 0 },
        removedNodes,
      } as unknown as MutationRecord,
    ]);

    expect(onLargeMutation).toHaveBeenCalledOnce();
  });

  it("releases a removed iframe observer and can observe it after reinsertion", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument!;
    const manager = new IframeManager({
      mirror: new Mirror(),
      mutationCb: vi.fn(),
      stylesheetManager: new StylesheetManager({
        mutationCb: vi.fn(),
        adoptedStyleSheetCb: vi.fn(),
      }),
      recordCrossOriginIframes: false,
      wrappedEmit: vi.fn(),
    });
    const observerCleanup = vi.fn();
    const observe = vi.fn(() => observerCleanup);
    manager.addLoadListener(observe);
    manager.addIframe(iframe, iframeDocument);
    manager.observeIframe(iframe);
    expect(observe).toHaveBeenCalledOnce();

    iframe.remove();
    manager.removeContainedIframes([iframe]);
    expect(observerCleanup).toHaveBeenCalledOnce();
    expect(manager.isCurrentDocument(iframeDocument)).toBe(false);

    document.body.appendChild(iframe);
    manager.addIframe(iframe, iframeDocument);
    manager.observeIframe(iframe);
    expect(observe).toHaveBeenCalledTimes(2);
    manager.reset();
  });

  it("releases nested iframe documents when their parent navigates", () => {
    const parent = document.createElement("iframe");
    document.body.appendChild(parent);
    const parentDocument = parent.contentDocument!;
    const nested = parentDocument.createElement("iframe");
    parentDocument.body.appendChild(nested);
    const nestedDocument = nested.contentDocument!;
    const manager = new IframeManager({
      mirror: new Mirror(),
      mutationCb: vi.fn(),
      stylesheetManager: new StylesheetManager({
        mutationCb: vi.fn(),
        adoptedStyleSheetCb: vi.fn(),
      }),
      recordCrossOriginIframes: false,
      wrappedEmit: vi.fn(),
    });
    const parentCleanup = vi.fn();
    const nestedCleanup = vi.fn();
    manager.addLoadListener((iframe) => (iframe === parent ? parentCleanup : nestedCleanup));
    const removedDocuments: Document[] = [];
    manager.addDocumentRemovedListener((doc) => removedDocuments.push(doc));
    manager.addIframe(parent, parentDocument);
    manager.observeIframe(parent);
    manager.addIframe(nested, nestedDocument);
    manager.observeIframe(nested);

    const replacement = document.implementation.createHTMLDocument("replacement");
    Object.defineProperty(parent, "contentDocument", {
      configurable: true,
      get: () => replacement,
    });
    manager.addIframe(parent, replacement);

    expect(parentCleanup).toHaveBeenCalledOnce();
    expect(nestedCleanup).toHaveBeenCalledOnce();
    expect(manager.isCurrentDocument(parentDocument)).toBe(false);
    expect(manager.isCurrentDocument(nestedDocument)).toBe(false);
    expect(removedDocuments).toEqual([nestedDocument, parentDocument]);
    manager.reset();
  });

  it("scans iframe owners once when a parent navigation clears a deep tree", () => {
    const parent = document.createElement("iframe");
    document.body.appendChild(parent);
    const parentDocument = parent.contentDocument!;
    const manager = new IframeManager({
      mirror: new Mirror(),
      mutationCb: vi.fn(),
      stylesheetManager: new StylesheetManager({
        mutationCb: vi.fn(),
        adoptedStyleSheetCb: vi.fn(),
      }),
      recordCrossOriginIframes: false,
      wrappedEmit: vi.fn(),
    });
    manager.addLoadListener(() => vi.fn());
    const removedDocuments: Document[] = [];
    manager.addDocumentRemovedListener((doc) => removedDocuments.push(doc));
    manager.addIframe(parent, parentDocument);

    const documents = [parentDocument];
    let ownerDocument = parentDocument;
    for (let depth = 0; depth < 8; depth += 1) {
      const nested = ownerDocument.createElement("iframe");
      ownerDocument.body.appendChild(nested);
      const nestedDocument = nested.contentDocument!;
      manager.addIframe(nested, nestedDocument);
      documents.push(nestedDocument);
      ownerDocument = nestedDocument;
    }

    class CountingIframeMap extends Map<HTMLIFrameElement, () => void> {
      public scans = 0;

      public override [Symbol.iterator]() {
        this.scans += 1;
        return super[Symbol.iterator]();
      }

      public override keys() {
        this.scans += 1;
        return super.keys();
      }
    }
    const internal = manager as unknown as {
      iframeLoadCleanups: Map<HTMLIFrameElement, () => void>;
    };
    const countedCleanups = new CountingIframeMap(internal.iframeLoadCleanups);
    internal.iframeLoadCleanups = countedCleanups;

    const replacement = document.implementation.createHTMLDocument("replacement");
    Object.defineProperty(parent, "contentDocument", {
      configurable: true,
      get: () => replacement,
    });
    manager.addIframe(parent, replacement);

    expect(countedCleanups.scans).toBe(1);
    expect(countedCleanups.size).toBe(1);
    expect(removedDocuments).toEqual([...documents].reverse());
    for (const oldDocument of documents) {
      expect(manager.isCurrentDocument(oldDocument)).toBe(false);
    }
    expect(manager.isCurrentDocument(replacement)).toBe(true);
    manager.reset();
  });

  it("keeps the optional cross-origin event path separate from normal iframe capture", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const mirror = new Mirror();
    mirror.add(iframe, {
      type: NodeType.Element,
      id: 10,
      tagName: "iframe",
      attributes: {},
      childNodes: [],
    });
    const wrappedEmit = vi.fn();
    const manager = new IframeManager({
      mirror,
      mutationCb: vi.fn(),
      stylesheetManager: new StylesheetManager({
        mutationCb: vi.fn(),
        adoptedStyleSheetCb: vi.fn(),
      }),
      recordCrossOriginIframes: true,
      wrappedEmit,
    });
    manager.addIframe(iframe);

    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: window.location.origin,
        data: {
          type: "rrweb",
          origin: window.location.origin,
          event: {
            type: EventType.FullSnapshot,
            timestamp: 1,
            data: {
              node: { type: NodeType.Document, id: 1, childNodes: [] },
              initialOffset: { top: 0, left: 0 },
            },
          },
        },
      }),
    );

    expect(manager.crossOriginIframeMirror).toBeDefined();
    expect(wrappedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EventType.IncrementalSnapshot,
        data: expect.objectContaining({
          source: IncrementalSource.Mutation,
          isAttachIframe: true,
          adds: [expect.objectContaining({ parentId: 10 })],
        }),
      }),
      undefined,
    );
    manager.reset();
  });

  it("releases the old document when an iframe becomes cross-origin", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument!;
    const manager = new IframeManager({
      mirror: new Mirror(),
      mutationCb: vi.fn(),
      stylesheetManager: new StylesheetManager({
        mutationCb: vi.fn(),
        adoptedStyleSheetCb: vi.fn(),
      }),
      recordCrossOriginIframes: false,
      wrappedEmit: vi.fn(),
    });
    const observerCleanup = vi.fn();
    const documentRemoved = vi.fn();
    manager.addLoadListener(() => observerCleanup);
    manager.addDocumentRemovedListener(documentRemoved);
    manager.addIframe(iframe, iframeDocument);
    manager.observeIframe(iframe);

    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => null,
    });
    iframe.dispatchEvent(new Event("load"));

    expect(observerCleanup).toHaveBeenCalledOnce();
    expect(documentRemoved).toHaveBeenCalledWith(iframeDocument);
    expect(manager.isCurrentDocument(iframeDocument)).toBe(false);
    manager.reset();
  });

  it("schedules one snapshot per loaded iframe document and removes its watcher", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const firstDocument = { readyState: "complete" } as Document;
    const loadingDocument = { readyState: "loading" } as Document;
    const secondDocument = { readyState: "complete" } as Document;
    const thirdDocument = { readyState: "complete" } as Document;
    let currentDocument = firstDocument;
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => currentDocument,
    });
    const stylesheetManager = new StylesheetManager({
      mutationCb: vi.fn(),
      adoptedStyleSheetCb: vi.fn(),
    });
    const manager = new IframeManager({
      mirror: new Mirror(),
      mutationCb: vi.fn(),
      stylesheetManager,
      recordCrossOriginIframes: false,
      wrappedEmit: vi.fn(),
    });
    expect(manager.crossOriginIframeMirror).toBeDefined();
    expect(manager.crossOriginIframeStyleMirror).toBeDefined();
    const scheduleSnapshot = vi.fn();
    manager.addSnapshotListener(scheduleSnapshot);
    manager.addIframe(iframe, firstDocument);

    iframe.dispatchEvent(new Event("load"));
    currentDocument = loadingDocument;
    iframe.dispatchEvent(new Event("load"));
    expect(scheduleSnapshot).not.toHaveBeenCalled();

    currentDocument = secondDocument;
    iframe.dispatchEvent(new Event("load"));
    iframe.dispatchEvent(new Event("load"));
    expect(scheduleSnapshot).toHaveBeenCalledTimes(1);

    currentDocument = thirdDocument;
    iframe.dispatchEvent(new Event("load"));
    expect(scheduleSnapshot).toHaveBeenCalledTimes(2);

    manager.reset();
    currentDocument = { readyState: "complete" } as Document;
    iframe.dispatchEvent(new Event("load"));
    expect(scheduleSnapshot).toHaveBeenCalledTimes(2);
  });
});

async function waitForFullSnapshot(
  events: readonly eventWithTime[],
  frameCallbacks: FrameRequestCallback[] = [],
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (events.some((event) => event.type === EventType.FullSnapshot)) return;
    frameCallbacks.shift()?.(attempt * 16);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Full snapshot was not emitted.");
}

async function drainSnapshotFrames(
  frameCallbacks: FrameRequestCallback[],
  events: readonly eventWithTime[],
  maxFrames = 1_000,
): Promise<void> {
  let quietFrames = 0;
  for (let frame = 0; frame < maxFrames; frame += 1) {
    const callback = frameCallbacks.shift();
    callback?.(frame * 16);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (
      events.some((event) => event.type === EventType.FullSnapshot) &&
      frameCallbacks.length === 0
    ) {
      quietFrames += 1;
      if (quietFrames === 2) return;
    } else {
      quietFrames = 0;
    }
  }
  throw new Error("Chunked snapshot did not finish.");
}

async function startChunkedSnapshot(frameCallbacks: FrameRequestCallback[]): Promise<void> {
  for (let frame = 0; frame < 3; frame += 1) {
    frameCallbacks.shift()?.(frame * 16);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function runSnapshotFramesUntil(
  frameCallbacks: FrameRequestCallback[],
  done: () => boolean,
  maxFrames: number,
): Promise<void> {
  for (let frame = 0; frame < maxFrames; frame += 1) {
    frameCallbacks.shift()?.(frame * 16);
    if (frame % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    else await Promise.resolve();
    if (done()) return;
  }
  throw new Error("Snapshot did not reach the expected state.");
}

async function drainSnapshotFramesQuick(
  frameCallbacks: FrameRequestCallback[],
  events: readonly eventWithTime[],
  maxFrames: number,
): Promise<void> {
  let quietFrames = 0;
  for (let frame = 0; frame < maxFrames; frame += 1) {
    frameCallbacks.shift()?.(frame * 16);
    if (frame % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    else await Promise.resolve();
    if (
      events.some((event) => event.type === EventType.FullSnapshot) &&
      frameCallbacks.length === 0
    ) {
      quietFrames += 1;
      if (quietFrames === 2) return;
    } else {
      quietFrames = 0;
    }
  }
  throw new Error("Chunked snapshot did not finish.");
}

async function waitForIframeAttachments(
  frameCallbacks: FrameRequestCallback[],
  events: readonly eventWithTime[],
  expectedCount: number,
): Promise<void> {
  for (let frame = 0; frame < 5_000; frame += 1) {
    frameCallbacks.shift()?.(frame * 16);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (iframeAttachEvents(events).length === expectedCount && frameCallbacks.length === 0) return;
  }
  throw new Error("Iframe snapshots did not finish.");
}

interface SnapshotNode {
  id: number;
  isShadow?: boolean;
  attributes?: Record<string, unknown>;
  childNodes?: SnapshotNode[];
}

function findSnapshotElement(root: SnapshotNode, name: string): SnapshotNode | undefined {
  if (root.attributes?.["data-test-node"] === name) return root;
  for (const child of root.childNodes ?? []) {
    const match = findSnapshotElement(child, name);
    if (match !== undefined) return match;
  }
  return undefined;
}

function iframeAttachEvents(events: readonly eventWithTime[]): eventWithTime[] {
  return events.filter(
    (event) =>
      event.type === EventType.IncrementalSnapshot &&
      event.data.source === IncrementalSource.Mutation &&
      event.data.isAttachIframe === true,
  );
}
