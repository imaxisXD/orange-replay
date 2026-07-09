export function cleanCountryCode(country: string | null | undefined): string | null {
  const code = country?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code;
}

export function formatCountryCode(country: string | null | undefined): string {
  return cleanCountryCode(country) ?? "Unknown";
}

export function formatLocationName(
  country: string | null | undefined,
  city: string | null,
): string {
  const cleanCity = city?.trim() ?? "";
  if (cleanCity.length > 0) return cleanCity;

  const code = cleanCountryCode(country);
  if (code !== null) return code;

  const fallback = country?.trim() ?? "";
  return fallback.length > 0 ? fallback.toUpperCase() : "Unknown";
}
