// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type serializedNodeWithId,
} from "../src/vendor/rrweb-types/index.ts";

let stopRecording: (() => void) | undefined;
const finishStylesheets: Array<() => void> = [];

afterEach(() => {
  stopRecording?.();
  stopRecording = undefined;
  for (const finish of finishStylesheets.splice(0)) finish();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe.each([false, true])("stylesheet lifecycle (SDK profile: %s)", (sdk) => {
  it("keeps initial CSS after an independent iframe snapshot", async () => {
    const { record } = await loadRecorder(sdk);
    const stylesheet = delayedStylesheet(document);
    document.head.appendChild(stylesheet.link);
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    iframe.contentDocument!.body.textContent = "separate iframe snapshot";
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      prepareForSnapshotPart: async () => undefined,
    });
    await waitFor(() => fullSnapshots(events).length === 1 && iframeSnapshots(events).length > 0);
    const linkId = capturedLinkId(events);

    stylesheet.load();

    await waitFor(() => cssUpdates(events).length > 0);
    expect(cssUpdates(events)).toEqual([
      expect.objectContaining({
        id: linkId,
        attributes: expect.objectContaining({ _cssText: expect.stringContaining("11, 22, 33") }),
      }),
    ]);
  });

  it("rejects the prior checkpoint callback but accepts the current one", async () => {
    const { record, takeFullSnapshot } = await loadRecorder(sdk);
    const stylesheet = delayedStylesheet(document);
    const listeners = vi.spyOn(stylesheet.link, "addEventListener");
    document.head.appendChild(stylesheet.link);
    const events: eventWithTime[] = [];
    stopRecording = record({ emit: (event) => events.push(event) });
    await waitFor(() => fullSnapshots(events).length === 1);
    const originalId = capturedLinkId(events);
    const oldLoad = listeners.mock.calls.find(([name]) => name === "load")![1] as EventListener;
    takeFullSnapshot(true);
    await waitFor(() => fullSnapshots(events).length === 2);
    stylesheet.makeAvailable();

    oldLoad(new Event("load"));
    expect(cssUpdates(events)).toEqual([]);
    stylesheet.link.dispatchEvent(new Event("load"));

    await waitFor(() => cssUpdates(events).length > 0);
    expect(cssUpdates(events).map((update) => update.id)).toEqual([originalId]);
  });

  it.each([
    ["initial", "removed"],
    ["initial", "blocked"],
    ["initial", "stopped"],
    ["incremental", "removed"],
    ["incremental", "blocked"],
    ["incremental", "stopped"],
  ])("does not publish %s CSS after its owner is %s", async (capture, state) => {
    const { record } = await loadRecorder(sdk);
    const owner = document.createElement("section");
    const stylesheet = delayedStylesheet(document);
    owner.appendChild(stylesheet.link);
    if (capture === "initial") document.body.appendChild(owner);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      blockSelector: "[data-orange-block]",
    });
    await waitFor(() => fullSnapshots(events).length === 1);
    if (capture === "incremental") {
      document.body.appendChild(owner);
      await waitFor(() => capturedLinkId(events) > 0);
    }
    if (state === "removed") owner.remove();
    else if (state === "blocked") owner.dataset.orangeBlock = "";
    else {
      stopRecording?.();
      stopRecording = undefined;
    }
    const eventCut = events.length;

    stylesheet.load();

    expect(cssUpdates(events.slice(eventCut))).toEqual([]);
    expect(JSON.stringify(events.slice(eventCut))).not.toContain("11, 22, 33");
  });

  it.each(["initial", "incremental"])(
    "rejects %s CSS from the previous iframe document",
    async (capture) => {
      const { record } = await loadRecorder(sdk);
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      const oldDocument = iframe.contentDocument!;
      const stylesheet = delayedStylesheet(oldDocument);
      if (capture === "initial") oldDocument.head.appendChild(stylesheet.link);
      const events: eventWithTime[] = [];
      stopRecording = record({
        emit: (event) => events.push(event),
        prepareForSnapshotPart: async () => undefined,
      });
      await waitFor(() => iframeSnapshots(events).length > 0);
      if (capture === "incremental") {
        oldDocument.head.appendChild(stylesheet.link);
        await waitFor(() => capturedLinkId(events) > 0);
      }
      const replacement = document.implementation.createHTMLDocument("new iframe document");
      Object.defineProperty(replacement, "readyState", { value: "complete" });
      Object.defineProperty(iframe, "contentDocument", {
        configurable: true,
        get: () => replacement,
      });
      iframe.dispatchEvent(new Event("load"));
      const eventCut = events.length;

      stylesheet.load();

      expect(cssUpdates(events.slice(eventCut))).toEqual([]);
      expect(JSON.stringify(events.slice(eventCut))).not.toContain("11, 22, 33");
    },
  );

  it("keeps an incremental link tied to its current node after a checkpoint", async () => {
    const { record, takeFullSnapshot } = await loadRecorder(sdk);
    const stylesheet = delayedStylesheet(document);
    const events: eventWithTime[] = [];
    stopRecording = record({ emit: (event) => events.push(event) });
    await waitFor(() => fullSnapshots(events).length === 1);
    document.head.appendChild(stylesheet.link);
    await waitFor(() => capturedLinkId(events) > 0);
    const originalId = capturedLinkId(events);
    takeFullSnapshot(true);
    await waitFor(() => fullSnapshots(events).length === 2);

    stylesheet.load();

    await waitFor(() => cssUpdates(events).length > 0);
    expect(cssUpdates(events).every((update) => update.id === originalId)).toBe(true);
  });

  it("does not send a stopped incremental callback through the next recording", async () => {
    const { record } = await loadRecorder(sdk);
    const stylesheet = delayedStylesheet(document);
    const listeners = vi.spyOn(stylesheet.link, "addEventListener");
    const oldEvents: eventWithTime[] = [];
    stopRecording = record({ emit: (event) => oldEvents.push(event) });
    await waitFor(() => fullSnapshots(oldEvents).length === 1);
    document.head.appendChild(stylesheet.link);
    await waitFor(() => capturedLinkId(oldEvents) > 0);
    const oldLoad = listeners.mock.calls.find(([name]) => name === "load")![1] as EventListener;
    stopRecording?.();
    const oldEventCount = oldEvents.length;
    const currentEvents: eventWithTime[] = [];
    stopRecording = record({ emit: (event) => currentEvents.push(event) });
    await waitFor(() => fullSnapshots(currentEvents).length === 1);
    const currentId = capturedLinkId(currentEvents);
    stylesheet.makeAvailable();

    oldLoad(new Event("load"));

    expect(oldEvents).toHaveLength(oldEventCount);
    expect(cssUpdates(currentEvents)).toEqual([]);
    stylesheet.link.dispatchEvent(new Event("load"));
    await waitFor(() => cssUpdates(currentEvents).length > 0);
    expect(cssUpdates(currentEvents).map((update) => update.id)).toEqual([currentId]);
  });

  it("preserves stylesheet capture under a text-masking selector", async () => {
    const { record } = await loadRecorder(sdk);
    const owner = document.createElement("section");
    owner.dataset.maskText = "";
    const stylesheet = delayedStylesheet(document);
    owner.appendChild(stylesheet.link);
    document.body.appendChild(owner);
    const events: eventWithTime[] = [];
    stopRecording = record({
      emit: (event) => events.push(event),
      maskTextSelector: "[data-mask-text]",
    });
    await waitFor(() => fullSnapshots(events).length === 1);

    stylesheet.load();

    await waitFor(() => cssUpdates(events).length > 0);
    expect(cssUpdates(events).map((update) => update.id)).toEqual([capturedLinkId(events)]);
  });
});

async function loadRecorder(sdk: boolean) {
  vi.resetModules();
  vi.stubGlobal("__ORANGE_REPLAY_SDK_PROFILE__", sdk);
  return import("../src/index.ts");
}

function delayedStylesheet(ownerDocument: Document) {
  const link = ownerDocument.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://example.test/lifecycle.css";
  link.dataset.testNode = "lifecycle-link";
  let sheet: CSSStyleSheet | undefined;
  const makeAvailable = () => {
    if (sheet !== undefined) return;
    sheet = new CSSStyleSheet();
    sheet.replaceSync(".late-color { color: rgb(11, 22, 33); }");
    Object.defineProperty(sheet, "href", { value: link.href });
    Object.defineProperty(link, "sheet", { configurable: true, get: () => sheet });
    vi.spyOn(ownerDocument, "styleSheets", "get").mockReturnValue([
      sheet,
    ] as unknown as StyleSheetList);
  };
  const load = () => {
    makeAvailable();
    link.dispatchEvent(new Event("load"));
  };
  finishStylesheets.push(load);
  return { link, makeAvailable, load };
}

async function waitFor(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 2_000, interval: 5 });
}

function mutations(events: readonly eventWithTime[]) {
  return events.flatMap((event) =>
    event.type === EventType.IncrementalSnapshot && event.data.source === IncrementalSource.Mutation
      ? [event.data]
      : [],
  );
}

function fullSnapshots(events: readonly eventWithTime[]) {
  return events.filter((event) => event.type === EventType.FullSnapshot);
}

function iframeSnapshots(events: readonly eventWithTime[]) {
  return mutations(events).filter((mutation) => mutation.isAttachIframe === true);
}

function cssUpdates(events: readonly eventWithTime[]) {
  return mutations(events)
    .flatMap((mutation) => mutation.attributes)
    .filter((attribute) => typeof attribute.attributes._cssText === "string");
}

function capturedLinkId(events: readonly eventWithTime[]): number {
  const findLink = (node: serializedNodeWithId): number | undefined => {
    if ("attributes" in node && node.attributes["data-test-node"] === "lifecycle-link")
      return node.id;
    if ("childNodes" in node) {
      for (const child of node.childNodes) {
        const id = findLink(child);
        if (id !== undefined) return id;
      }
    }
    return undefined;
  };
  const roots = [
    ...fullSnapshots(events).map((event) => event.data.node),
    ...mutations(events).flatMap((mutation) => mutation.adds.map((addition) => addition.node)),
  ];
  const id = roots.map(findLink).find((id) => id !== undefined);
  if (id === undefined) throw new Error("The snapshot did not contain its stylesheet link.");
  return id;
}
