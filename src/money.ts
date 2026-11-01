// Money is handled as integer minor units (cents, yen, fils) everywhere. Shopify's MoneyV2.amount is a
// `Decimal` string such as "12.99"; it is parsed here WITHOUT floating point, and digits beyond the
// currency's exponent must be zero ("12.990" is fine, "12.999" is an error, never a silent rounding).
export class MoneyError extends Error {
  override name = "MoneyError";
}

// ISO 4217 minor-unit exponents. Unknown codes throw instead of guessing "2".
const ZERO = ["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"];
const THREE = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];
const TWO = [
  "AED", "ARS", "AUD", "BAM", "BBD", "BDT", "BGN", "BND", "BOB", "BRL", "BSD", "BWP", "BZD", "CAD", "CHF", "CNY", "COP", "CRC", "CZK", "DKK",
  "DOP", "DZD", "EGP", "EUR", "FJD", "GBP", "GEL", "GHS", "GTQ", "GYD", "HKD", "HNL", "HRK", "HUF", "IDR", "ILS", "INR", "JMD", "KES", "KHR",
  "KZT", "LAK", "LBP", "LKR", "MAD", "MDL", "MKD", "MMK", "MOP", "MUR", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "PAB",
  "PEN", "PHP", "PKR", "PLN", "QAR", "RON", "RSD", "RUB", "SAR", "SEK", "SGD", "THB", "TTD", "TRY", "TWD", "TZS", "UAH", "USD", "UYU", "UZS",
  "VES", "XCD", "YER", "ZAR", "ZMW",
];
const EXPONENTS = new Map<string, number>([...ZERO.map((c) => [c, 0] as const), ...TWO.map((c) => [c, 2] as const), ...THREE.map((c) => [c, 3] as const)]);

export function currencyExponent(currency: string): number {
  const exp = EXPONENTS.get(currency);
  if (exp === undefined) throw new MoneyError(`unknown currency code ${JSON.stringify(currency)} (add it to the exponent table in src/money.ts)`);
  return exp;
}

export function parseDecimalToMinor(amount: string, currency: string): number {
  const exp = currencyExponent(currency);
  if (typeof amount !== "string") throw new MoneyError(`amount must be a decimal string, got ${typeof amount}`);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) throw new MoneyError(`not a plain decimal amount: ${JSON.stringify(amount)}`);
  const sign = m[1] ?? "";
  const whole = m[2] ?? "0";
  const fraction = m[3] ?? "";
  if (/[1-9]/.test(fraction.slice(exp))) {
    throw new MoneyError(`${JSON.stringify(amount)} has more decimal places than ${currency} allows (${exp})`);
  }
  const minor = Number(whole + (fraction + "0".repeat(exp)).slice(0, exp));
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`amount out of range: ${JSON.stringify(amount)}`);
  return sign === "-" && minor !== 0 ? -minor : minor;
}

export function formatMinor(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`minor units must be a safe integer, got ${minor}`);
  const exp = currencyExponent(currency);
  const abs = Math.abs(minor);
  const sign = minor < 0 ? "-" : "";
  if (exp === 0) return `${sign}${abs}`;
  const digits = String(abs).padStart(exp + 1, "0");
  return `${sign}${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

/** Integer addition that refuses to leave the exactly-representable range instead of silently losing cents. */
export function addMinor(...values: number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new MoneyError(`not an integer amount of minor units: ${v}`);
    total += v;
    if (!Number.isSafeInteger(total)) throw new MoneyError("sum exceeds the safe integer range");
  }
  return total;
}
