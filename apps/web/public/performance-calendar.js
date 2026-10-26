// Calendar geometry for already-aggregated performance points. This module
// never reads measurements or computes their statistics.
const DAY = 86_400_000;
const formatters = new Map();

export function validPerformanceTimeZone(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_+/-]{0,99}$/u.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

export function systemPerformanceTimeZone() {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validPerformanceTimeZone(value) ? value : "UTC";
  } catch { return "UTC"; }
}

export function performanceCalendarDay(at, timeZone = "UTC") {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone, year: "numeric", month: "numeric", day: "numeric",
    });
    if (formatters.size >= 8) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  const date = new Date(0);
  date.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return date.getTime() / DAY;
}

// Search for the first instant in the civil date, including midnight gaps or
// repeated midnights. Skipped civil dates resolve to the next observed date.
export function performanceCalendarBoundary(day, timeZone = "UTC") {
  if (timeZone === "UTC") return day * DAY;
  let low = day * DAY - 36 * 3_600_000;
  let high = day * DAY + 36 * 3_600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (performanceCalendarDay(middle, timeZone) < day) low = middle;
    else high = middle;
  }
  return high;
}

export function performanceCalendarBin(at, interval, timeZone = "UTC") {
  const day = performanceCalendarDay(at, timeZone);
  return interval === "week" ? Math.floor((day - 4) / 7) * 7 + 4 : day;
}
