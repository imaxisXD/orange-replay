import type { canvasMutationCallback, listenerHandler } from "../../../../rrweb-types/index.ts";

export class CanvasManager {
  public reset(): void {}

  public freeze(): void {}

  public unfreeze(): void {}

  public lock(): void {}

  public unlock(): void {}

  public resetObservers?: listenerHandler;

  public constructor(_options: { mutationCb: canvasMutationCallback }) {}
}
