import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHOP, fixtureDocument } from "../testing/order-fixtures.ts";

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

describe("fixtures/orders.json", () => {
  it("is exactly what scripts/generate-fixtures.ts produces from the specs (no hand edits, no drift)", () => {
    expect(read("fixtures/orders.json")).toBe(JSON.stringify(fixtureDocument(), null, 2) + "\n");
  });

  it("describes a fictional shop and says the data is not from a store", () => {
    const doc = JSON.parse(read("fixtures/orders.json")) as { _note: string; shop: typeof SHOP };
    expect(doc.shop).toEqual(SHOP);
    expect(doc._note).toContain("FICTIONAL");
    expect(doc._note).toContain("NEVER exported from a Shopify store");
  });

  it("contains no email addresses, phone numbers or names of people", () => {
    const text = read("fixtures/orders.json");
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\+\d{7,}/);
  });

  it("has unique ids and every order has money in both the shop and the presentment currency", () => {
    const { orders } = JSON.parse(read("fixtures/orders.json")) as { orders: Array<Record<string, any>> };
    expect(new Set(orders.map((o) => o["id"])).size).toBe(orders.length);
    for (const o of orders) {
      expect(o["totalPriceSet"].shopMoney.currencyCode).toBe("CAD");
      expect(o["totalPriceSet"].presentmentMoney.currencyCode).toBe(o["presentmentCurrencyCode"]);
    }
  });

  it("covers the situations the dashboard has to get right", () => {
    const { orders } = JSON.parse(read("fixtures/orders.json")) as { orders: Array<Record<string, any>> };
    expect(orders.some((o) => o["test"] === true)).toBe(true);
    expect(orders.some((o) => o["cancelledAt"] !== null)).toBe(true);
    expect(new Set(orders.map((o) => o["presentmentCurrencyCode"]))).toEqual(new Set(["CAD", "USD", "JPY", "GBP"]));
    expect(orders.some((o) => o["refunds"].length > 0 && o["displayFinancialStatus"] === "REFUNDED")).toBe(true);
    expect(orders.some((o) => o["displayFinancialStatus"] === "PARTIALLY_REFUNDED")).toBe(true);
  });
});

describe("repository hygiene", () => {
  it("no tracked source or doc file contains a secret-looking token", () => {
    const files = ["src", "testing", "scripts", "test", "docs", "fixtures"].flatMap((dir) => readdirSync(new URL(`${dir}/`, root), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${e.parentPath.replace(root.pathname, "")}/${e.name}`));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const text = readFileSync(new URL(f, root), "utf8");
      expect(text, f).not.toMatch(/shpat_[0-9a-f]{20,}/); // a real-looking Admin API token
      expect(text, f).not.toMatch(/shpss_[0-9a-f]{20,}/);
      expect(text, f).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
  });
});
