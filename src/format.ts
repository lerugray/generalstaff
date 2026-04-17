// GeneralStaff — formatting helpers

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

// Convention (gs-060, 2026-04-16): sub-KB values are floored to integer
// bytes. "1023.5 B" is ugly and never actually arises in practice (disk
// stat sizes are always integers), so we collapse the sub-KB case to the
// cleanest representation. KB+ tiers keep one-decimal precision.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < KB) return `${Math.floor(bytes)} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return "?";
  return `${Math.round(ratio * 100)}%`;
}

// gs-085: human-friendly relative-time formatter for status/history lines.
// Buckets: <60s -> "just now"; <1h -> "N min ago"; same calendar day and
// >=1h -> "Nh ago"; prior calendar day -> "yesterday at HH:MM"; older ->
// "N days ago". Future times mirror past ("in N min", "in Nh", "in N days").
// The "yesterday" bucket is intentionally calendar-based, not a 24h window,
// so early-morning reads of a late-night event read naturally.
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const thenMs = then.getTime();
  if (!Number.isFinite(thenMs)) return "?";

  const deltaSec = Math.floor((now.getTime() - thenMs) / 1000);
  const absSec = Math.abs(deltaSec);
  const future = deltaSec < 0;

  if (absSec < 60) return "just now";

  if (absSec < 3600) {
    const mins = Math.floor(absSec / 60);
    return future ? `in ${mins} min` : `${mins} min ago`;
  }

  if (future) {
    if (absSec < 86400) {
      return `in ${Math.floor(absSec / 3600)}h`;
    }
    return `in ${Math.floor(absSec / 86400)} days`;
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thenDay = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const dayDiff = Math.round((today.getTime() - thenDay.getTime()) / 86400000);

  if (dayDiff === 0) {
    return `${Math.floor(absSec / 3600)}h ago`;
  }
  if (dayDiff === 1) {
    const hh = String(then.getHours()).padStart(2, "0");
    const mm = String(then.getMinutes()).padStart(2, "0");
    return `yesterday at ${hh}:${mm}`;
  }
  return `${dayDiff} days ago`;
}
