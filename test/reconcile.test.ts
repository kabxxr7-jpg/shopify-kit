import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregateSales, type AggregateOptions, type AggregateResult } from "../src/aggregate.ts";
import type { Order } from "../src/orders.ts";
import { REPORT_METRICS, formatDiffs, reconcile, type ReportJson } from "../src/reconcile.ts";
import { formatMinor, parseDecimalToMinor } from "../src/money.ts";

const read = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const orders = (JSON.parse(read("orders.json")) as { orders: Order[] }).orders;
const report = (mode: "shop" | "presentment"): ReportJson => JSON.parse(read(`shopify-report.${mode}.json`)) as ReportJson;
const WINDOW: AggregateOptions = { timeZone: "America/Toronto", from: "2026-10-29", until: "2026-11-03" };
const actual = (mode: "shop" | "presentment", over: Partial<AggregateOptions> = {}): AggregateResult => aggregateSales(orders, { ...WINDOW, currency: mode, ...over });

describe("the dashboard reconciles to the hand-derived report, to the cent", () => {
  it.each([["shop", 66], ["presentment", 143]] as const)("%s currency: every row and total matches (%i values compared)", (mode, values) => {
    const result = reconcile(actual(mode), report(mode));
    expect(result.diffs).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkedValues).toBe(values);
    expect(formatDiffs(result)).toBe(`reconciled: ${values} values compared, 0 differences (to the cent)`);
  });

  it("is not satisfied by luck: changing any single value by one minor unit in the report is caught, exactly once, with the right delta", () => {
    let perturbed = 0;
    for (const mode of ["shop", "presentment"] as const) {
      const base = report(mode);
      const sections: Array<Record<string, string | number>> = [...base.rows, ...Object.values(base.totals)];
      for (const section of sections) {
        const currency = String((section as { currency?: string }).currency ?? Object.keys(base.totals).find((c) => base.totals[c] === section));
        for (const metric of REPORT_METRICS) {
          const copy = structuredClone(base);
          const target = [...copy.rows, ...Object.values(copy.totals)][sections.indexOf(section)]!;
          const before = target[metric]!;
          target[metric] = metric === "orders" ? (before as number) + 1 : formatMinor(parseDecimalToMinor(before as string, currency) + 1, currency);
          const result = reconcile(actual(mode), copy);
          expect(result.diffs, `${mode} ${metric}`).toHaveLength(1);
          expect(result.diffs[0]!.delta).toBe(-1);
          expect(result.diffs[0]!.metric).toBe(metric);
          perturbed++;
        }
      }
    }
    expect(perturbed).toBe(66 + 143);
  });

  it("names the day, currency, metric and both values when a row differs", () => {
    const bad = report("shop");
    bad.rows[0]!["taxes"] = "11.65";
    const result = reconcile(actual("shop"), bad);
    expect(result.ok).toBe(false);
    expect(result.diffs[0]).toMatchObject({ scope: "row", day: "2026-10-30", currency: "CAD", metric: "taxes", expected: "11.65", actual: "11.64", delta: -1 });
    expect(formatDiffs(result)).toContain("NOT reconciled: 1 difference(s) in 66 values compared");
    expect(formatDiffs(result)).toContain("2026-10-30 CAD taxes: report 11.65, dashboard 11.64 (delta -1 minor units)");
  });

  it("a total that disagrees while every row agrees is reported as a TOTAL difference", () => {
    const bad = report("shop");
    bad.totals["CAD"]!["total_sales"] = "400.88";
    const result = reconcile(actual("shop"), bad);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({ scope: "total", day: null, metric: "total_sales" });
    expect(formatDiffs(result)).toContain("TOTAL CAD total_sales");
  });

  it("the report's own rows add up to its totals (the hand-written file is internally consistent)", () => {
    for (const mode of ["shop", "presentment"] as const) {
      const r = report(mode);
      for (const [currency, totals] of Object.entries(r.totals)) {
        for (const metric of REPORT_METRICS) {
          if (metric === "net_sales" || metric === "total_sales") continue;
          const sum = r.rows.filter((row) => row.currency === currency).reduce((acc, row) => acc + (metric === "orders" ? (row[metric] as number) : parseDecimalToMinor(row[metric] as string, currency)), 0);
          expect(sum, `${mode} ${currency} ${metric}`).toBe(metric === "orders" ? (totals[metric] as number) : parseDecimalToMinor(totals[metric] as string, currency));
        }
      }
    }
  });
});

describe("the reconciliation is sensitive to the mistakes it exists to catch", () => {
  it.each([
    ["UTC day boundaries instead of the shop's time zone", { timeZone: "UTC" }],
    ["a fixed UTC-4 offset (wrong after the DST change)", { timeZone: "Etc/GMT+4" }],
    ["created-at instead of processed-at dates", { dateField: "createdAt" }],
    ["counting test orders", { excludeTest: false }],
    ["counting cancelled orders", { excludeCancelled: false }],
    ["a different window (dropping the first day)", { from: "2026-10-31" }],
  ] as const)("fails for %s", (_name, over) => {
    const result = reconcile(actual("shop", over as Partial<AggregateOptions>), report("shop"));
    expect(result.ok).toBe(false);
    expect(result.diffs.length).toBeGreaterThan(0);
  });

  it("fails when the wrong money side is aggregated (presentment numbers against the shop-currency report)", () => {
    expect(reconcile(actual("presentment"), report("shop")).ok).toBe(false);
  });

  it("fails when an order is missing from the input", () => {
    const fewer = aggregateSales(orders.filter((o) => o.name !== "#1010"), { ...WINDOW, currency: "shop" });
    expect(reconcile(fewer, report("shop")).ok).toBe(false);
  });
});

describe("report file handling", () => {
  it("a day missing from the dashboard is a difference unless the report row is all zeros", () => {
    const base = report("shop");
    const missing = { ...base, rows: [...base.rows, { day: "2026-11-04", currency: "CAD", ...Object.fromEntries(REPORT_METRICS.map((m) => [m, m === "orders" ? 1 : "5.00"])) }] } as ReportJson;
    expect(reconcile(actual("shop"), missing).diffs).toEqual([expect.objectContaining({ day: "2026-11-04", metric: "row", expected: "present", actual: "missing" })]);
    const zeros = { ...base, rows: [...base.rows, { day: "2026-11-04", currency: "CAD", ...Object.fromEntries(REPORT_METRICS.map((m) => [m, m === "orders" ? 0 : "0.00"])) }] } as ReportJson;
    expect(reconcile(actual("shop"), zeros).ok).toBe(true);
  });

  it("a day on the dashboard that the report lacks is a difference", () => {
    const base = report("shop");
    const without = { ...base, rows: base.rows.slice(1) };
    expect(reconcile(actual("shop"), without).diffs[0]).toMatchObject({ day: "2026-10-30", metric: "row", expected: "absent", actual: "present" });
  });

  it("a currency present on only one side is a difference", () => {
    const base = report("presentment");
    const { USD: _usd, ...rest } = base.totals;
    const diffs = reconcile(actual("presentment"), { ...base, totals: rest }).diffs;
    expect(diffs.some((d) => d.scope === "total" && d.currency === "USD")).toBe(true);
  });

  it("refuses a report that lists the same day and currency twice", () => {
    const base = report("shop");
    expect(() => reconcile(actual("shop"), { ...base, rows: [...base.rows, base.rows[0]!] })).toThrow(/twice/);
  });

  it("refuses amounts given as JSON numbers (trailing zeros and float error), a string order count, or a missing metric", () => {
    const num = report("shop");
    num.rows[0]!["gross_sales"] = 78.5;
    expect(() => reconcile(actual("shop"), num)).toThrow(/decimal string/);
    const str = report("shop");
    str.rows[0]!["orders"] = "2";
    expect(() => reconcile(actual("shop"), str)).toThrow(/orders must be a non-negative integer/);
    const missing = report("shop");
    delete missing.rows[0]!["taxes"];
    expect(() => reconcile(actual("shop"), missing)).toThrow(/no value for taxes/);
  });
});

describe("honesty of the report fixtures", () => {
  it.each(["shop", "presentment"] as const)("the %s report says it is hand-written, not a Shopify export, and shows its working on every row", (mode) => {
    const r = report(mode) as ReportJson & { provenance: string };
    expect(r.provenance).toContain("HAND-WRITTEN");
    expect(r.provenance).toContain("NOT exported from a Shopify store");
    for (const row of r.rows) expect(typeof row["derivation"]).toBe("string");
  });
});
