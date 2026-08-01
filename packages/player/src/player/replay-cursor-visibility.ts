const CURSOR_POSITIONED_ATTRIBUTE = "data-orange-replay-positioned";

export interface ReplayCursorVisibility {
  reset(): void;
  stop(): void;
}

export function watchReplayCursorPosition(wrapper: HTMLElement): ReplayCursorVisibility {
  const cursor = wrapper.querySelector<HTMLElement>(".replayer-mouse");
  if (cursor === null) {
    return emptyCursorVisibility();
  }

  const updateVisibility = () => {
    cursor.toggleAttribute(CURSOR_POSITIONED_ATTRIBUTE, hasRecordedPosition(cursor));
  };
  const observerConstructor = wrapper.ownerDocument.defaultView?.MutationObserver;
  const observer =
    observerConstructor === undefined ? undefined : new observerConstructor(updateVisibility);

  updateVisibility();
  observer?.observe(cursor, { attributes: true, attributeFilter: ["style"] });

  return {
    reset() {
      cursor.style.removeProperty("left");
      cursor.style.removeProperty("top");
      updateVisibility();
    },
    stop() {
      observer?.disconnect();
    },
  };
}

function hasRecordedPosition(cursor: HTMLElement): boolean {
  return cursor.style.left.trim().length > 0 && cursor.style.top.trim().length > 0;
}

function emptyCursorVisibility(): ReplayCursorVisibility {
  return {
    reset() {
      /* the replay cursor has not been created */
    },
    stop() {
      /* there is no replay cursor observer to stop */
    },
  };
}
