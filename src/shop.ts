// Shop domain validation. The pattern is the one printed in Shopify's "Authenticate a standalone or API-only
// app" page (section "Validate the shop domain"). It must be anchored at both ends: without the trailing `$`,
// `exampleshop.myshopify.com.attacker.example` would pass and the authorization code would be sent to a host
// the attacker controls. In JavaScript `$` (without the `m` flag) matches only at the very end of the string,
// so a trailing newline does not slip through either.
export const SHOP_DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;

export function isValidShopDomain(shop: unknown): shop is string {
  return typeof shop === "string" && SHOP_DOMAIN_PATTERN.test(shop);
}

/** Lower-cases a validated shop domain so it can be used as a stable key (host names are case-insensitive). */
export function normalizeShopDomain(shop: string): string {
  if (!isValidShopDomain(shop)) throw new Error(`not a valid myshopify.com domain: ${JSON.stringify(shop)}`);
  return shop.toLowerCase();
}
