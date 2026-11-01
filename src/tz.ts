// Calendar-day bucketing in an IANA time zone. Shopify reports are shown in the shop's time zone
// (Shop.ianaTimezone), so "which day did this order happen on" must use that zone, not UTC and not a fixed
// offset (a fixed offset breaks on the day daylight saving time changes).
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // throws RangeError for an unknown zone
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", calendar: "gregory", numberingSystem: "latn" });
    formatters.set(timeZone, f);
  }
  return f;
}

export function assertTimeZone(timeZone: string): void {
  if (typeof timeZone !== "string" || timeZone.length === 0) throw new Error("timeZone must be an IANA zone name such as America/Toronto");
  try {
    formatterFor(timeZone);
  } catch {
    throw new Error(`unknown time zone: ${JSON.stringify(timeZone)}`);
  }
}

/** The calendar day (YYYY-MM-DD) that the instant falls on in `timeZone`. Accepts an ISO 8601 string with Z or an offset. */
export function localDay(instant: string | number | Date, timeZone: string): string {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new Error(`not a valid timestamp: ${JSON.stringify(instant)}`);
  assertTimeZone(timeZone);
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: string): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`could not format ${type} for ${timeZone}`);
    return part.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isLocalDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}
