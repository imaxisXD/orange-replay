import * as v from "valibot";

const websiteOriginSchema = v.pipe(
  v.string(),
  v.check(isExactHttpOrigin, "Website origin must be an exact http or https origin."),
);
const storedWebsiteOriginsSchema = v.pipe(
  v.array(websiteOriginSchema),
  v.minLength(1),
  v.maxLength(2),
  v.check((origins) => new Set(origins).size === origins.length, "Website origins must be unique."),
);

export function parseStoredWebsiteOrigins(value: string): string[] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Stored Website origins are not valid JSON.");
  }

  const parsed = v.safeParse(storedWebsiteOriginsSchema, parsedJson);
  if (!parsed.success) throw new Error("Stored Website origins are invalid.");
  return parsed.output;
}

function isExactHttpOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.origin === value
  );
}
