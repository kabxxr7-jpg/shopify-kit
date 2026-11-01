// Runs the real theme-check (the npm package) as a subprocess on the sample theme, before and after the fixes,
// and compares with the committed results. If theme-check changes its findings, these fail and the results must be re-captured.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url).pathname;
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");
// The first line of the output names the Node version that ran it; that is provenance, not a finding, so it is ignored in the comparison.
const sameOutput = (actual: string, committed: string): void => {
  const noNode = (text: string): string => text.replace(/\(node v\d+\.\d+\.\d+;/, "(node vX;");
  expect(noNode(actual)).toBe(noNode(committed));
};
const run = (dir: string) => spawnSync(process.execPath, ["scripts/theme-check.mjs", dir, "--offline"], { cwd: root, encoding: "utf8", timeout: 120_000 });

describe("theme-check on the sample theme", () => {
  it("finds exactly the five planted problems in theme/before, with the checks the README names", () => {
    const r = run("theme/before");
    expect(r.status).toBe(1);
    sameOutput(r.stdout, read("theme/results/before.txt"));
    const results = JSON.parse(read("theme/results/before.json")) as { offenses: Array<{ check: string; file: string }> };
    expect(results.offenses.map((o) => [o.check, o.file])).toEqual([
      ["ParserBlockingScript", "layout/theme.liquid"],
      ["UndefinedObject", "sections/product-main.liquid"],
      ["UnusedAssign", "snippets/price.liquid"],
      ["ImgWidthAndHeight", "snippets/product-card.liquid"],
      ["MissingTemplate", "snippets/product-card.liquid"],
    ]);
  });

  it("is clean after the fixes: zero offenses of any severity", () => {
    const r = run("theme/after");
    expect(r.status).toBe(0);
    sameOutput(r.stdout, read("theme/results/after.txt"));
    expect(r.stdout).toContain("0 offenses");
  });

  it("the committed results were produced by the theme-check version that is installed now", () => {
    const installed = (JSON.parse(read("node_modules/@shopify/theme-check-node/package.json")) as { version: string }).version;
    for (const name of ["before", "after"]) {
      const results = JSON.parse(read(`theme/results/${name}.json`)) as { tool: Record<string, string>; docs: { revision: string } };
      expect(results.tool["@shopify/theme-check-node"]).toBe(installed);
      expect(results.docs.revision).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("the fixed theme differs from the broken one only where the findings are", () => {
    const diff = spawnSync("diff", ["-r", "theme/before", "theme/after"], { cwd: root, encoding: "utf8" });
    const touched = diff.stdout.split("\n").filter((l) => l.startsWith("diff -r") || l.startsWith("Only in")).length;
    expect(touched).toBe(5); // four edited files + the snippet that did not exist
  });

  it("exits 2 with a usage message when no folder is given", () => {
    expect(spawnSync(process.execPath, ["scripts/theme-check.mjs"], { cwd: root, encoding: "utf8" }).status).toBe(2);
  });
});
