const BrowserNode = (globalThis as { Node?: typeof Node }).Node;
const BrowserIFrame = (globalThis as { HTMLIFrameElement?: typeof HTMLIFrameElement })
  .HTMLIFrameElement;

export type RRNode = Node;
export type RRIFrameElement = HTMLIFrameElement;

export const RRNode = BrowserNode ?? (class RRNode {} as unknown as typeof Node);
export const RRIFrameElement =
  BrowserIFrame ?? (class RRIFrameElement {} as unknown as typeof HTMLIFrameElement);
export class BaseRRNode {}
