import { formatDuration } from "@/lib/format";

export const numberFormatter = new Intl.NumberFormat();

export const percentFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

export function formatPercent(value: number | null): string {
  return value === null ? "—" : percentFormatter.format(value);
}

export function formatOptionalDuration(value: number | null): string {
  return value === null ? "—" : formatDuration(value);
}

export function formatScrollDepth(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}
