import type { OrangePlayerEventMap, OrangePlayerEventName, OrangePlayerHandler } from "./types.ts";

export class PlayerEmitter {
  private readonly handlers = new Map<OrangePlayerEventName, Set<(payload: unknown) => void>>();

  on<K extends OrangePlayerEventName>(name: K, handler: OrangePlayerHandler<K>): () => void {
    let set = this.handlers.get(name);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(name, set);
    }

    set.add(handler as (payload: unknown) => void);
    return () => this.off(name, handler);
  }

  off<K extends OrangePlayerEventName>(name: K, handler: OrangePlayerHandler<K>): void {
    this.handlers.get(name)?.delete(handler as (payload: unknown) => void);
  }

  emit<K extends OrangePlayerEventName>(name: K, payload: OrangePlayerEventMap[K]): void {
    const set = this.handlers.get(name);
    if (set === undefined) {
      return;
    }

    for (const handler of set) {
      handler(payload);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
