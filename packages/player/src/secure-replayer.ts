import { Replayer, type eventWithTime } from "rrweb";
import { installReplayFramePolicy, REPLAY_FRAME_CSP } from "./replay-security.ts";

type ReplayerEvents = eventWithTime[];
type ReplayerConfig = ConstructorParameters<typeof Replayer>[1];
const REPLAY_POLICY_NODE_ID = Number.MIN_SAFE_INTEGER;
const REPLAY_POLICY_HEAD_ID = Number.MIN_SAFE_INTEGER + 1;

export function createSecureReplayer(events: ReplayerEvents, config: ReplayerConfig): Replayer {
  const replayer = new Replayer(secureReplayEvents(events), config);
  if (installReplayFramePolicy(replayer.iframe)) {
    return replayer;
  }

  replayer.destroy();
  throw new Error("Could not install the replay security policy.");
}

export function secureReplayEvents(events: ReplayerEvents): ReplayerEvents {
  return events.map((event) => {
    if (event.type !== 2 || !isRecord(event.data) || !isRecord(event.data["node"])) {
      return event;
    }

    const root = event.data["node"];
    return {
      ...event,
      data: {
        ...event.data,
        node: cloneWithReplayPolicy(root),
      },
    } as typeof event;
  });
}

function cloneWithReplayPolicy(root: Record<string, unknown>): unknown {
  let foundHead = false;

  const cloneNode = (node: unknown): unknown => {
    if (!isRecord(node)) {
      return node;
    }

    const clone = { ...node };
    const tagName = typeof node["tagName"] === "string" ? node["tagName"].toLowerCase() : undefined;
    const children = Array.isArray(node["childNodes"])
      ? node["childNodes"].filter((child) => !isInjectedReplayPolicy(child)).map(cloneNode)
      : undefined;

    if (tagName === "head" && !foundHead) {
      foundHead = true;
      clone["childNodes"] = [createReplayPolicyNode(), ...(children ?? [])];
      return clone;
    }

    if (tagName === "html" && !containsHead(node) && !foundHead) {
      foundHead = true;
      clone["childNodes"] = [createHeadNode(), ...(children ?? [])];
      return clone;
    }

    if (children !== undefined) {
      clone["childNodes"] = children;
    }
    return clone;
  };

  return cloneNode(root);
}

function createHeadNode(): Record<string, unknown> {
  return {
    type: 2,
    id: REPLAY_POLICY_HEAD_ID,
    tagName: "head",
    attributes: {},
    childNodes: [createReplayPolicyNode()],
  };
}

function createReplayPolicyNode(): Record<string, unknown> {
  return {
    type: 2,
    // Recorded node IDs are positive. rrweb's virtual DOM starts its own
    // temporary IDs at -2, so use the far end of the safe integer range for
    // Orange Replay's synthetic policy nodes.
    id: REPLAY_POLICY_NODE_ID,
    tagName: "meta",
    attributes: {
      // rrweb deliberately renames recorded CSP content. The lowercase value
      // identifies this as Orange Replay's policy while remaining valid HTML.
      "http-equiv": "content-security-policy",
      content: REPLAY_FRAME_CSP,
      "data-orange-replay-policy": "true",
    },
    childNodes: [],
  };
}

function containsHead(node: Record<string, unknown>): boolean {
  const children = node["childNodes"];
  return (
    Array.isArray(children) &&
    children.some(
      (child) =>
        isRecord(child) &&
        typeof child["tagName"] === "string" &&
        child["tagName"].toLowerCase() === "head",
    )
  );
}

function isInjectedReplayPolicy(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value["attributes"])) {
    return false;
  }
  return value["attributes"]["data-orange-replay-policy"] === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
