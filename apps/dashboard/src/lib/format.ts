const absoluteTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function formatRelativeTime(value: number, now = Date.now()): string {
  return formatRelativeTimeValue(value, now, { nowLabel: "just now", suffix: " ago" });
}

export function formatShortRelativeTime(value: number, now = Date.now()): string {
  return formatRelativeTimeValue(value, now, { nowLabel: "now", suffix: "" });
}

function formatRelativeTimeValue(
  value: number,
  now: number,
  options: { nowLabel: string; suffix: string },
): string {
  const diffMs = Math.max(0, now - value);
  const seconds = Math.floor(diffMs / 1_000);

  if (seconds < 10) return options.nowLabel;
  if (seconds < 60) return `${seconds}s${options.suffix}`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${options.suffix}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${options.suffix}`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d${options.suffix}`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo${options.suffix}`;

  const years = Math.floor(months / 12);
  return `${years}y${options.suffix}`;
}

export function formatAbsoluteTime(value: number): string {
  return absoluteTimeFormatter.format(new Date(value));
}

export function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.round(value / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}:${padTimePart(remainingSeconds)}`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}:${padTimePart(remainingMinutes)}:${padTimePart(remainingSeconds)}`;
}

/**
 * Session-surface duration: sub-second recordings show as "<1s" instead of
 * rounding to 0:00. Playback clocks keep plain formatDuration so a running
 * timer never displays the token.
 */
export function formatSessionDuration(value: number): string {
  if (value > 0 && value < 1_000) return "<1s";
  return formatDuration(value);
}

export function formatDurationWords(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(formatTimeUnit(hours, "hour"));
  if (minutes > 0) parts.push(formatTimeUnit(minutes, "minute"));
  if (seconds > 0 || parts.length === 0) parts.push(formatTimeUnit(seconds, "second"));

  return parts.join(" ");
}

export function formatErrorCount(count: number): string {
  return `${count} ${count === 1 ? "error" : "errors"}`;
}

function padTimePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatTimeUnit(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}
