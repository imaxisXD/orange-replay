// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type mutationData,
  type serializedNodeWithId,
} from "../src/vendor/rrweb-types/index.ts";

let stopRecording: (() => void) | undefined;
const pendingLinks: HTMLLinkElement[] = [];

afterEach(() => {
  stopRecording?.();
  stopRecording = undefined;
  for (const link of pendingLinks.splice(0)) link.dispatchEvent(new Event("load"));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

async function loadRecorder(sdk: boolean) {
  vi.resetModules();
  vi.stubGlobal("__ORANGE_REPLAY_SDK_PROFILE__", sdk);
  return import("../src/index.ts");
}

function delayedStylesheet() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://example.test/late.css";
  link.dataset.testNode = "late-stylesheet";
  const child = document.createElement("span");
  child.textContent = "scripted link child";
  link.appendChild(child);
  pendingLinks.push(link);
  return {
    link,
    child,
    load: () => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(".late-color { color: rgb(11, 22, 33); }");
      Object.defineProperty(sheet, "href", { value: link.href });
      Object.defineProperty(link, "sheet", { configurable: true, get: () => sheet });
      vi.spyOn(document, "styleSheets", "get").mockReturnValue([
        sheet,
      ] as unknown as StyleSheetList);
      link.dispatchEvent(new Event("load"));
    },
  };
}

async function waitFor(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 2_000, interval: 5 });
}

function mutations(events: readonly eventWithTime[]): mutationData[] {
  return events.flatMap((event) =>
    event.type === EventType.IncrementalSnapshot && event.data.source === IncrementalSource.Mutation
      ? [event.data]
      : [],
  );
}

function fullSnapshots(events: readonly eventWithTime[]) {
  return events.filter((event) => event.type === EventType.FullSnapshot);
}

function findNode(
  root: serializedNodeWithId,
  matches: (node: serializedNodeWithId) => boolean,
): serializedNodeWithId | undefined {
  if (matches(root)) return root;
  if ("childNodes" in root) {
    for (const child of root.childNodes) {
      const found = findNode(child, matches);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function capturedNode(
  events: readonly eventWithTime[],
  matches: (node: serializedNodeWithId) => boolean,
) {
  const roots = [
    ...fullSnapshots(events).map((event) => event.data.node),
    ...mutations(events).flatMap((mutation) => mutation.adds.map((addition) => addition.node)),
  ];
  return roots.map((root) => findNode(root, matches)).find((node) => node !== undefined);
}

function cssUpdates(events: readonly eventWithTime[]) {
  return mutations(events)
    .flatMap((mutation) => mutation.attributes)
    .filter((attribute) => typeof attribute.attributes._cssText === "string");
}

describe.each([false, true])("delayed stylesheets (SDK profile: %s)", (sdk) => {
  it.each(["initial", "incremental"])(
    "keeps the %s link ID and later nested mutations when CSS loads",
    async (capture) => {
      const { record } = await loadRecorder(sdk);
      const { link, child, load } = delayedStylesheet();
      if (capture === "initial") document.head.appendChild(link);
      const events: eventWithTime[] = [];
      stopRecording = record({ emit: (event) => events.push(event), snapshotTimeSliceMs: 1 });
      await waitFor(() => fullSnapshots(events).length === 1);
      if (capture === "incremental") document.head.appendChild(link);
      const capturedLink = () =>
        capturedNode(events, (node) =>
          "attributes" in node ? node.attributes["data-test-node"] === "late-stylesheet" : false,
        );
      const capturedText = () =>
        capturedNode(events, (node) =>
          "textContent" in node ? node.textContent === "scripted link child" : false,
        );
      await waitFor(() => capturedLink() !== undefined && capturedText() !== undefined);
      const linkId = capturedLink()!.id;
      const textId = capturedText()!.id;

      load();
      await waitFor(() => cssUpdates(events).length > 0);
      expect(cssUpdates(events).map((update) => update.id)).toEqual([linkId]);
      expect(cssUpdates(events)[0]!.attributes._cssText).toContain("rgb(11, 22, 33)");

      child.firstChild!.textContent = "updated link child";
      const nested = document.createElement("b");
      nested.textContent = "new nested child";
      child.appendChild(nested);
      await waitFor(() =>
        mutations(events).some((mutation) =>
          mutation.texts.some((text) => text.id === textId && text.value === "updated link child"),
        ),
      );
      await waitFor(
        () =>
          capturedNode(events, (node) =>
            "textContent" in node ? node.textContent === "new nested child" : false,
          ) !== undefined,
      );
    },
  );
});

it("keeps generic synchronous recursion and iframe load callbacks", async () => {
  const { snapshot, Mirror } = await loadRecorder(false);
  const host = document.createElement("section");
  host.innerHTML = "<p>ordinary child</p>";
  host.attachShadow({ mode: "open" }).innerHTML = "<b>shadow child</b>";
  const iframe = document.createElement("iframe");
  document.body.append(host, iframe);
  iframe.contentDocument!.body.textContent = "iframe child";
  const mirror = new Mirror();
  const onSerialize = vi.fn();
  const onIframeLoad = vi.fn();
  const tree = snapshot(document, { mirror, onSerialize, onIframeLoad });
  expect(tree).not.toBeNull();
  for (const text of ["ordinary child", "shadow child"]) {
    expect(
      findNode(tree!, (node) => "textContent" in node && node.textContent === text),
    ).toBeDefined();
  }
  expect(onSerialize).toHaveBeenCalledWith(host.shadowRoot!.firstChild!.firstChild);
  iframe.dispatchEvent(new Event("load"));
  await waitFor(() => onIframeLoad.mock.calls.length > 0);
  const frameTree = onIframeLoad.mock.calls.at(-1)![1] as serializedNodeWithId;
  const frameText = findNode(
    frameTree,
    (node) => "textContent" in node && node.textContent === "iframe child",
  );
  expect(frameText).toBeDefined();
  expect(frameText?.rootId).toBe(mirror.getId(iframe.contentDocument!));
});
