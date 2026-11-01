import { describe, expect, it } from "vitest";
import { isValidShopDomain, normalizeShopDomain } from "../src/shop.ts";

describe("shop domain validation", () => {
  it.each(["harbour-pine-demo.myshopify.com", "a.myshopify.com", "Shop-1.myshopify.com", "9lives.myshopify.com"])("accepts %s", (shop) => {
    expect(isValidShopDomain(shop)).toBe(true);
  });

  it.each([
    "harbour-pine-demo.myshopify.com.attacker.example", // missing end anchor would let this through
    "attacker.example/harbour-pine-demo.myshopify.com",
    "harbour-pine-demo.myshopify.com\n",
    "harbour-pine-demo.myshopify.com ",
    "https://harbour-pine-demo.myshopify.com",
    "harbour-pine-demo.myshopify.com:443",
    "harbour-pine-demo.myshopify.com/",
    "-leading-dash.myshopify.com",
    "a..myshopify.com",
    "a.b.myshopify.com",
    "evil.com",
    "myshopify.com",
    ".myshopify.com",
    "",
    "shop.myshopify.co",
    "user@shop.myshopify.com",
    "shop.MYSHOPIFY.COM", // the documented pattern is case-sensitive after the shop name; Shopify sends lower case
  ])("rejects %j", (shop) => {
    expect(isValidShopDomain(shop)).toBe(false);
  });

  it("rejects values that are not strings", () => {
    for (const v of [undefined, null, 42, {}, ["a.myshopify.com"]]) expect(isValidShopDomain(v)).toBe(false);
  });

  it("normalises to lower case and throws on an invalid domain", () => {
    expect(normalizeShopDomain("Harbour-Pine.myshopify.com")).toBe("harbour-pine.myshopify.com");
    expect(() => normalizeShopDomain("evil.com")).toThrow(/not a valid myshopify.com domain/);
  });
});
