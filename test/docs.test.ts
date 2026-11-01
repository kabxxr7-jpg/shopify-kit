import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

// The README and docs make claims about the repository (what exists, what was and was not done). These tests keep
// those claims from drifting away from the code.
describe("README and docs", () => {
  const readme = read("README.md");

  it("opens with a Status line that says the kit was never run on Shopify", () => {
    const status = readme.split("\n").find((l) => l.startsWith("**Status"));
    expect(status).toBeDefined();
    expect(status).toMatch(/never run on Shopify/i);
  });

  it("says in the README and in both report files that the Shopify report was not exported from a store", () => {
    expect(readme).toMatch(/not exported from a (real )?store/i);
    for (const file of ["fixtures/shopify-report.shop.json", "fixtures/shopify-report.presentment.json"]) {
      const report = JSON.parse(read(file)) as { provenance: string };
      expect(report.provenance, file).toMatch(/NOT exported from a Shopify store/);
      expect(report.provenance, file).toMatch(/HAND-WRITTEN/);
    }
  });

  it("has the sections the kit promises", () => {
    for (const heading of ["## Quickstart", "## Limits", "## What this does not prove", "## Mutation check", "## Tests"]) {
      expect(readme, heading).toContain(heading);
    }
  });

  it("only refers to npm scripts that exist", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    const used = new Set<string>();
    for (const file of ["README.md", "docs/SETUP-GUIDE.md", "docs/GO-LIVE-CHECKLIST.md"]) {
      for (const m of read(file).matchAll(/npm run ([a-z][a-z:-]*)/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(3);
    for (const name of used) expect(scripts, `npm run ${name}`).toHaveProperty(name);
  });

  it("only links to files that exist", () => {
    for (const file of ["README.md", "docs/SETUP-GUIDE.md", "docs/GO-LIVE-CHECKLIST.md", "docs/NOT-COVERED.md", "docs/SOURCES.md"]) {
      const dir = file.includes("/") ? "docs/" : "";
      for (const m of read(file).matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)) {
        const target = new URL(`${dir}${m[1]}`, root);
        expect(existsSync(target), `${file} links to ${m[1]}`).toBe(true);
      }
    }
  });

  it("states the number of mutants that scripts/mutation-check.mjs really contains", () => {
    const count = (read("scripts/mutation-check.mjs").match(/^\s*swap\("M\d+-/gm) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(30);
    expect(readme).toContain(`${count} documented ways`);
  });
});

describe("docs/GO-LIVE-CHECKLIST.md", () => {
  const checklist = read("docs/GO-LIVE-CHECKLIST.md");

  it("is blank: nothing is ticked and the 'ran on a development store' line is not filled in", () => {
    expect(checklist).toMatch(/Ran on a development store on: ____-__-__/);
    expect(checklist).not.toMatch(/- \[[xX]\]/);
    expect((checklist.match(/- \[ \]/g) ?? []).length).toBeGreaterThan(40);
  });
});

describe("docs/SOURCES.md", () => {
  const sources = read("docs/SOURCES.md");

  it("gives the date the pages were read and only lists shopify.dev addresses with a scheme", () => {
    expect(sources).toContain("2026-11-01");
    const urls = [...sources.matchAll(/\| (https?:\/\/[^ |]+) \|/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(30);
    for (const url of urls) expect(url, url).toMatch(/^https:\/\/shopify\.dev\/docs\//);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("mentions the 404 and the unread Help Center pages instead of hiding them", () => {
    expect(sources).toMatch(/404/);
    expect(sources).toMatch(/not\*\* read/);
  });
});

describe("docs/NOT-COVERED.md", () => {
  it("names the main gaps: never run on Shopify, hand-written report, unencrypted tokens, toy cost model", () => {
    const text = read("docs/NOT-COVERED.md");
    expect(text).toMatch(/never run on Shopify/i);
    expect(text).toMatch(/written by hand/i);
    expect(text).toMatch(/unencrypted/i);
    expect(text).toMatch(/toy/i);
  });
});
