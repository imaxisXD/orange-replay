// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import { installReplayFramePolicy, REPLAY_FRAME_CSP } from "../src/replay-security.ts";
import { secureReplayEvents } from "../src/secure-replayer.ts";
import type { ReplayEvent } from "../src/types.ts";

describe("replay frame security policy", () => {
  it("secures every full snapshot without using the next recorded node id", () => {
    const snapshot = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          id: 100,
          tagName: "html",
          attributes: {},
          childNodes: [
            {
              type: 2,
              id: 101,
              tagName: "head",
              attributes: {},
              childNodes: [],
            },
          ],
        },
      },
    } as unknown as ReplayEvent;

    const first = secureReplayEvents([snapshot])[0]!;
    const second = secureReplayEvents([first])[0]!;
    const root = (second.data as { node: Record<string, unknown> }).node;
    const head = (root["childNodes"] as Array<Record<string, unknown>>)[0]!;
    const policyNodes = (head["childNodes"] as Array<Record<string, unknown>>).filter(
      (node) =>
        (node["attributes"] as Record<string, unknown> | undefined)?.[
          "data-orange-replay-policy"
        ] === "true",
    );

    expect(policyNodes).toHaveLength(1);
    expect(policyNodes[0]?.["id"]).toBe(Number.MIN_SAFE_INTEGER);
    expect(policyNodes[0]?.["id"]).not.toBe(102);
  });

  it("locks the replay frame before rrweb writes the recorded document", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);

    expect(installReplayFramePolicy(iframe)).toBe(true);
    expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(iframe.referrerPolicy).toBe("no-referrer");

    const policy = iframe.contentDocument?.head.firstElementChild;
    expect(policy?.tagName).toBe("META");
    expect(policy?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(policy?.getAttribute("content")).toBe(REPLAY_FRAME_CSP);
    expect(REPLAY_FRAME_CSP).toContain("default-src 'none'");
    expect(REPLAY_FRAME_CSP).toContain("connect-src 'none'");
    expect(REPLAY_FRAME_CSP).toContain("script-src 'none'");
    expect(REPLAY_FRAME_CSP).toContain("style-src 'unsafe-inline' blob:");
    expect(REPLAY_FRAME_CSP).toContain("img-src data: blob:");

    iframe.remove();
  });

  it("does not add a second policy when the player rebuilds", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);

    expect(installReplayFramePolicy(iframe)).toBe(true);
    expect(installReplayFramePolicy(iframe)).toBe(true);
    expect(
      iframe.contentDocument?.head.querySelectorAll("meta[data-orange-replay-policy]"),
    ).toHaveLength(1);

    iframe.remove();
  });

  it("blocks resource properties and cleans style APIs inside the replay frame", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    expect(installReplayFramePolicy(iframe)).toBe(true);

    const frameDocument = iframe.contentDocument;
    expect(frameDocument).not.toBeNull();

    const image = frameDocument!.createElement("img");
    image.src = "https://private.example/customer.png";
    expect(image.getAttribute("src")).toBeNull();

    image.src = "data:image/png;base64,c2FmZQ==";
    expect(image.getAttribute("src")).toBe("data:image/png;base64,c2FmZQ==");

    const card = frameDocument!.createElement("div");
    card.setAttribute(
      "style",
      "display: grid; background-image: url(https://private.example/pixel.png)",
    );
    expect(card.getAttribute("style")).toBe("display:grid;background-image:url(data:,)");

    card.style.setProperty("border-image-source", "url(https://private.example/border.png)");
    expect(card.style.getPropertyValue("border-image-source")).toBe('url("data:,")');

    iframe.remove();
  });
});
