import { describe, expect, it } from "vitest";
import { assertTimeZone, isLocalDay, localDay } from "../src/tz.ts";

const TORONTO = "America/Toronto";

describe("localDay: shop time zone, not UTC", () => {
  it.each([
    ["2026-10-31T03:30:00Z", "2026-10-30"], // 23:30 EDT the day before the UTC date
    ["2026-10-31T04:00:00Z", "2026-10-31"], // exactly midnight EDT
    ["2026-10-31T03:59:59Z", "2026-10-30"],
    ["2026-11-01T03:59:00Z", "2026-10-31"],
  ])("%s -> %s (EDT, UTC-4)", (instant, day) => {
    expect(localDay(instant, TORONTO)).toBe(day);
  });

  it("handles the autumn change on 2026-11-01 (EDT -> EST): that local day is 25 hours long", () => {
    expect(localDay("2026-11-01T04:00:00Z", TORONTO)).toBe("2026-11-01"); // 00:00 EDT
    expect(localDay("2026-11-01T05:59:59Z", TORONTO)).toBe("2026-11-01"); // 01:59:59 EDT
    expect(localDay("2026-11-01T06:00:00Z", TORONTO)).toBe("2026-11-01"); // 01:00:00 EST, the repeated hour
    expect(localDay("2026-11-02T04:59:59Z", TORONTO)).toBe("2026-11-01"); // 23:59:59 EST; a fixed UTC-4 offset would say Nov 2
    expect(localDay("2026-11-02T05:00:00Z", TORONTO)).toBe("2026-11-02"); // 00:00 EST
  });

  it("handles the spring change on 2026-03-08 (EST -> EDT): that local day is 23 hours long", () => {
    expect(localDay("2026-03-08T04:59:59Z", TORONTO)).toBe("2026-03-07"); // 23:59:59 EST
    expect(localDay("2026-03-08T05:00:00Z", TORONTO)).toBe("2026-03-08"); // 00:00 EST
    expect(localDay("2026-03-09T03:59:59Z", TORONTO)).toBe("2026-03-08"); // 23:59:59 EDT
    expect(localDay("2026-03-09T04:00:00Z", TORONTO)).toBe("2026-03-09"); // 00:00 EDT
  });

  it("works east of UTC with a half-hour offset (Asia/Kolkata, UTC+5:30)", () => {
    expect(localDay("2026-10-31T18:29:59Z", "Asia/Kolkata")).toBe("2026-10-31");
    expect(localDay("2026-10-31T18:30:00Z", "Asia/Kolkata")).toBe("2026-11-01");
  });

  it("honours an explicit offset in the timestamp", () => {
    expect(localDay("2026-10-31T23:30:00-04:00", TORONTO)).toBe("2026-10-31");
    expect(localDay("2026-10-31T23:30:00-04:00", "UTC")).toBe("2026-11-01");
  });

  it("accepts epoch milliseconds and Date objects", () => {
    const ms = Date.parse("2026-10-31T03:30:00Z");
    expect(localDay(ms, TORONTO)).toBe("2026-10-30");
    expect(localDay(new Date(ms), TORONTO)).toBe("2026-10-30");
  });

  it("rejects an invalid timestamp or zone", () => {
    expect(() => localDay("not a date", TORONTO)).toThrow(/not a valid timestamp/);
    expect(() => localDay("2026-10-31T00:00:00Z", "Mars/Olympus")).toThrow(/unknown time zone/);
    expect(() => assertTimeZone("")).toThrow(/IANA zone/);
    expect(() => assertTimeZone(undefined as unknown as string)).toThrow(/IANA zone/);
  });
});

describe("isLocalDay", () => {
  it("accepts real calendar days only", () => {
    expect(isLocalDay("2026-11-01")).toBe(true);
    expect(isLocalDay("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-1-01", "2026-11-1", "20261101", "2026-11-01T00:00:00Z", "", "today"]) expect(isLocalDay(bad)).toBe(false);
  });
});
