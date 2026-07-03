// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EventType, IncrementalSource, record, type eventWithTime } from "../src/index.ts";

const waitForMutationFlush = () => new Promise((resolve) => setTimeout(resolve, 30));

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("record", () => {
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
