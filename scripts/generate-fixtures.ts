// Regenerates fixtures/orders.json from the specs in testing/order-fixtures.ts:  node scripts/generate-fixtures.ts
// (A test regenerates it in memory and compares, so the committed file cannot drift from the specs.)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixtureDocument } from "../testing/order-fixtures.ts";

const target = fileURLToPath(new URL("../fixtures/orders.json", import.meta.url));
writeFileSync(target, JSON.stringify(fixtureDocument(), null, 2) + "\n");
console.log(`wrote ${target}`);
