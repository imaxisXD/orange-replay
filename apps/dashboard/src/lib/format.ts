export function formatRelativeTime(value: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - value);
  const seconds = Math.floor(diffMs / 1_000);

  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export function formatAbsoluteTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

export function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.round(value / 1_000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60)
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1_024;
  let unitIndex = 0;

  while (size >= 1_024 && unitIndex < units.length - 1) {
    size /= 1_024;
    unitIndex += 1;
  }

  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}
