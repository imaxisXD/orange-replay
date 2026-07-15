export function entryPath(value: string | null): string {
  if (value === null || value.length === 0) return "/";

  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}
