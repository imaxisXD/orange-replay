import { init, type InitOptions } from "./index.ts";

const loaderWindow = window as Window & { __orInit?: unknown; __orq?: unknown[] };
const isInitOptions = (value: unknown): value is InitOptions => {
  const options = value as Partial<InitOptions> | null;
  return typeof options?.key === "string" && typeof options.ingestUrl === "string";
};
let loaderOptions = isInitOptions(loaderWindow.__orInit) ? loaderWindow.__orInit : undefined;
if (loaderOptions === undefined && Array.isArray(loaderWindow.__orq)) {
  const queued = loaderWindow.__orq.find((item) => {
    const entry = item as { k?: unknown; o?: unknown } | null;
    return entry?.k === "init" && isInitOptions(entry.o);
  }) as { o: InitOptions } | undefined;
  loaderOptions = queued?.o;
}
if (loaderOptions !== undefined) init(loaderOptions);

export default { init };
