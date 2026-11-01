// Reconciliation: compares an AggregateResult with a "Shopify report" (rows per day and currency, plus totals)
// metric by metric, in integer minor units. Zero tolerance: one cent of difference is a difference.
//
// The report file format is documented in fixtures/README-style form in the README. NOTE: the report shipped
// in fixtures/ was written by hand from the published metric definitions; it was not exported from a store.
import type { AggregateResult, Metrics, Row } from "./aggregate.ts";
import { parseDecimalToMinor, formatMinor } from "./money.ts";

export const REPORT_METRICS = [
  "orders",
  "gross_sales",
  "discounts",
  "net_sales_reversals",
  "net_sales",
  "shipping_charges",
  "shipping_reversals",
  "taxes",
  "tax_reversals",
  "other_refunds",
  "total_sales",
] as const satisfies ReadonlyArray<keyof Metrics>;
export type ReportMetric = (typeof REPORT_METRICS)[number];

export interface ReportRowJson {
  day: string;
  currency: string;
  [metric: string]: string | number;
}
export interface ReportJson {
  shop?: { domain?: string; currency?: string; timeZone?: string };
  rows: ReportRowJson[];
  totals: Record<string, Record<string, string | number>>;
}

export interface Diff {
  scope: "row" | "total";
  day: string | null;
  currency: string;
  metric: ReportMetric | "row";
  expected: string;
  actual: string;
  /** actual - expected, in minor units (orders: count). */
  delta: number;
}
export interface ReconcileResult {
  ok: boolean;
  checkedValues: number;
  diffs: Diff[];
}

function metricValue(raw: string | number | undefined, metric: ReportMetric, currency: string, where: string): number {
  if (raw === undefined) throw new Error(`report ${where} has no value for ${metric}`);
  if (metric === "orders") {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) throw new Error(`report ${where}: orders must be a non-negative integer`);
    return raw;
  }
  if (typeof raw !== "string") throw new Error(`report ${where}: ${metric} must be a decimal string like "12.50" (numbers hide trailing zeros and invite float errors)`);
  return parseDecimalToMinor(raw, currency);
}

const show = (metric: ReportMetric | "row", value: number, currency: string): string => (metric === "orders" || metric === "row" ? String(value) : formatMinor(value, currency));

export function reconcile(actual: AggregateResult, report: ReportJson): ReconcileResult {
  const diffs: Diff[] = [];
  let checked = 0;
  const actualRows = new Map<string, Row>(actual.rows.map((r): [string, Row] => [`${r.day}|${r.currency}`, r]));
  const seen = new Set<string>();

  for (const expectedRow of report.rows) {
    const key = `${expectedRow.day}|${expectedRow.currency}`;
    if (seen.has(key)) throw new Error(`report lists ${key} twice`);
    seen.add(key);
    const row = actualRows.get(key);
    if (!row) {
      // a report row of all zeros for a day without activity is not a difference
      const allZero = REPORT_METRICS.every((m) => metricValue(expectedRow[m], m, expectedRow.currency, key) === 0);
      if (!allZero) diffs.push({ scope: "row", day: expectedRow.day, currency: expectedRow.currency, metric: "row", expected: "present", actual: "missing", delta: -1 });
      continue;
    }
    for (const metric of REPORT_METRICS) {
      const expected = metricValue(expectedRow[metric], metric, expectedRow.currency, key);
      checked++;
      if (row[metric] !== expected) {
        diffs.push({ scope: "row", day: row.day, currency: row.currency, metric, expected: show(metric, expected, row.currency), actual: show(metric, row[metric], row.currency), delta: row[metric] - expected });
      }
    }
  }
  for (const [key, row] of actualRows) {
    if (!seen.has(key)) diffs.push({ scope: "row", day: row.day, currency: row.currency, metric: "row", expected: "absent", actual: "present", delta: 1 });
  }

  const currencies = new Set([...Object.keys(report.totals), ...Object.keys(actual.totals)]);
  for (const currency of [...currencies].sort()) {
    const expectedTotals = report.totals[currency];
    const actualTotals = actual.totals[currency];
    if (!expectedTotals || !actualTotals) {
      diffs.push({ scope: "total", day: null, currency, metric: "row", expected: expectedTotals ? "present" : "absent", actual: actualTotals ? "present" : "missing", delta: expectedTotals ? -1 : 1 });
      continue;
    }
    for (const metric of REPORT_METRICS) {
      const expected = metricValue(expectedTotals[metric], metric, currency, `totals.${currency}`);
      checked++;
      if (actualTotals[metric] !== expected) {
        diffs.push({ scope: "total", day: null, currency, metric, expected: show(metric, expected, currency), actual: show(metric, actualTotals[metric], currency), delta: actualTotals[metric] - expected });
      }
    }
  }
  return { ok: diffs.length === 0, checkedValues: checked, diffs };
}

export function formatDiffs(result: ReconcileResult): string {
  if (result.ok) return `reconciled: ${result.checkedValues} values compared, 0 differences (to the cent)`;
  const lines = [`NOT reconciled: ${result.diffs.length} difference(s) in ${result.checkedValues} values compared`];
  for (const d of result.diffs) {
    lines.push(`  ${d.scope === "total" ? "TOTAL" : d.day} ${d.currency} ${d.metric}: report ${d.expected}, dashboard ${d.actual} (delta ${d.delta > 0 ? "+" : ""}${d.delta} minor units)`);
  }
  return lines.join("\n");
}
