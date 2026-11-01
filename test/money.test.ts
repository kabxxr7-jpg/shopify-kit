import { describe, expect, it } from "vitest";
import { MoneyError, addMinor, currencyExponent, formatMinor, parseDecimalToMinor } from "../src/money.ts";

describe("currency exponents", () => {
  it("knows zero-, two- and three-decimal currencies", () => {
    for (const c of ["JPY", "KRW", "CLP", "ISK", "VND"]) expect(currencyExponent(c)).toBe(0);
    for (const c of ["CAD", "USD", "EUR", "GBP", "INR"]) expect(currencyExponent(c)).toBe(2);
    for (const c of ["KWD", "BHD", "OMR", "TND"]) expect(currencyExponent(c)).toBe(3);
  });
  it("refuses an unknown code instead of assuming two decimals", () => {
    expect(() => currencyExponent("ZZZ")).toThrow(MoneyError);
    expect(() => currencyExponent("cad")).toThrow(MoneyError);
  });
});

describe("parseDecimalToMinor", () => {
  it.each([
    ["12.50", "CAD", 1250],
    ["12.5", "CAD", 1250],
    ["12", "CAD", 1200],
    ["0.07", "CAD", 7],
    ["0.00", "CAD", 0],
    ["19.99", "USD", 1999], // 19.99 * 100 is 1998.9999999999998 in floating point
    ["-3.10", "EUR", -310],
    ["12.990", "CAD", 1299],
    ["1853", "JPY", 1853],
    ["1853.00", "JPY", 1853],
    ["1.234", "KWD", 1234],
  ])("%s %s -> %i", (amount, currency, minor) => {
    expect(parseDecimalToMinor(amount, currency)).toBe(minor);
  });

  it("returns +0, never -0", () => {
    expect(Object.is(parseDecimalToMinor("-0.00", "CAD"), 0)).toBe(true);
  });

  it.each([
    ["12.999", "CAD"],
    ["1.005", "CAD"],
    ["1853.5", "JPY"],
    ["1.2345", "KWD"],
  ])("refuses to round %s %s", (amount, currency) => {
    expect(() => parseDecimalToMinor(amount, currency)).toThrow(/more decimal places/);
  });

  it.each(["", "abc", "1e3", "1,000.00", " 12.00", "12.00 ", "12.", ".5", "--1", "+1.00", "1.2.3", "NaN", "Infinity"])("rejects %j", (amount) => {
    expect(() => parseDecimalToMinor(amount, "CAD")).toThrow(MoneyError);
  });

  it("rejects non-strings and amounts beyond the safe integer range", () => {
    expect(() => parseDecimalToMinor(12.5 as unknown as string, "CAD")).toThrow(/decimal string/);
    expect(() => parseDecimalToMinor("90071992547409.93", "CAD")).toThrow(/out of range/);
  });

  it("is exact where floats are not: 0.1 + 0.2 is 30 cents", () => {
    expect(addMinor(parseDecimalToMinor("0.10", "CAD"), parseDecimalToMinor("0.20", "CAD"))).toBe(30);
  });
});

describe("formatMinor", () => {
  it.each([
    [1250, "CAD", "12.50"],
    [5, "CAD", "0.05"],
    [0, "CAD", "0.00"],
    [-5, "CAD", "-0.05"],
    [-12345, "USD", "-123.45"],
    [1853, "JPY", "1853"],
    [-1853, "JPY", "-1853"],
    [1234, "KWD", "1.234"],
    [7, "KWD", "0.007"],
  ])("%i %s -> %s", (minor, currency, text) => {
    expect(formatMinor(minor, currency)).toBe(text);
  });

  it("round-trips with parseDecimalToMinor over a range, for each exponent", () => {
    for (const currency of ["CAD", "JPY", "KWD"]) {
      for (let minor = -2500; minor <= 2500; minor += 7) expect(parseDecimalToMinor(formatMinor(minor, currency), currency)).toBe(minor);
    }
  });

  it("rejects fractional or unsafe minor units", () => {
    expect(() => formatMinor(12.5, "CAD")).toThrow(MoneyError);
    expect(() => formatMinor(Number.MAX_SAFE_INTEGER + 1, "CAD")).toThrow(MoneyError);
  });
});

describe("addMinor", () => {
  it("sums integers, and nothing is 0", () => {
    expect(addMinor(1, 2, 3)).toBe(6);
    expect(addMinor()).toBe(0);
    expect(addMinor(500, -200)).toBe(300);
  });
  it("refuses fractions, NaN and overflow instead of losing cents", () => {
    expect(() => addMinor(0.5)).toThrow(MoneyError);
    expect(() => addMinor(Number.NaN)).toThrow(MoneyError);
    expect(() => addMinor(Number.MAX_SAFE_INTEGER, 1)).toThrow(/safe integer/);
    expect(() => addMinor(-Number.MAX_SAFE_INTEGER, -1)).toThrow(/safe integer/);
  });
});
