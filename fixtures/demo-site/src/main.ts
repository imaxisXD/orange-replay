import { init, type OrangeReplayHandle } from "@orange-replay/sdk";

declare const __ORANGE_REPLAY_WORKER_URL__: string | undefined;
declare const __ORANGE_REPLAY_INGEST_KEY__: string | undefined;

declare global {
  interface Window {
    __orangeReplay?: OrangeReplayHandle;
  }
}

const ingestKey =
  typeof __ORANGE_REPLAY_INGEST_KEY__ === "string" ? __ORANGE_REPLAY_INGEST_KEY__ : "or_demo_key";
const ingestUrl =
  typeof __ORANGE_REPLAY_WORKER_URL__ === "string"
    ? __ORANGE_REPLAY_WORKER_URL__
    : "http://127.0.0.1:8787";
const params = new URLSearchParams(window.location.search);
const sampleRate = params.get("sampleRate") === "0" ? 0 : 1;
const transport = params.get("transport") === "inline" ? "inline" : undefined;

const handle = init({
  key: ingestKey,
  ingestUrl,
  sampleRate,
  flushMs: 1_000,
  transport,
});

window.__orangeReplay = handle;

document.querySelector("[data-add-row]")?.addEventListener("click", () => {
  const list = document.querySelector("[data-stock-list]");
  const row = document.createElement("li");
  row.textContent = "Central warehouse added a fresh quality check.";
  list?.appendChild(row);
});

document.querySelector("[data-open-panel]")?.addEventListener("click", (event) => {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  const panel = document.querySelector(".product-panel");
  panel?.classList.toggle("is-open");
  button.textContent =
    panel?.classList.contains("is-open") === true ? "Hide stock panel" : "Show stock panel";
});

document.querySelector("[data-save-settings]")?.addEventListener("click", () => {
  handle.addCustomEvent("settings:saved", { area: "team-access" });
});

document.querySelector("[data-confirm-checklist]")?.addEventListener("click", () => {
  handle.addCustomEvent("order:checklist-confirmed", { page: 2 });
});

document.querySelector("[data-throw-error]")?.addEventListener("click", () => {
  const broken = undefined as unknown as { run(): void };
  broken.run();
});
