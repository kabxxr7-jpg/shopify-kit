#!/usr/bin/env node
// Runs the REAL theme-check (@shopify/theme-check-node from npm, a dev dependency) on a theme folder.
//   node scripts/theme-check.mjs theme/before --offline --json theme/results/before.json --text theme/results/before.txt
//
// Nothing here is simulated: the offenses are whatever theme-check reports. The script only
//   * sends the tool's docs cache to a git-ignored folder inside this repo (HOME is overridden), and
//   * with --offline, blocks network access so theme-check uses the Liquid reference docs bundled in the npm
//     package (revision recorded in the output) and the result does not depend on what shopify.dev serves today.
// Exit code: 0 = no offenses of any severity, 1 = offenses found, 2 = could not run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a, i) => !a.startsWith("--") && !["--json", "--text"].includes(args[i - 1] ?? ""));
if (!target) {
  console.error("usage: node scripts/theme-check.mjs <theme folder> [--offline] [--json file] [--text file]");
  process.exit(2);
}

process.env.HOME = join(repo, ".theme-check-home"); // docs cache (env-paths) and any global config lookup stay inside the repo
mkdirSync(process.env.HOME, { recursive: true });

if (flag("offline")) {
  const refuse = (what) => () => {
    throw new Error(`network access disabled by --offline (${what})`);
  };
  const require = createRequire(import.meta.url);
  for (const name of ["node:http", "node:https"]) {
    const mod = require(name);
    mod.request = refuse(`${name}.request`);
    mod.get = refuse(`${name}.get`);
  }
  globalThis.fetch = async () => {
    throw new Error("network access disabled by --offline (fetch)");
  };
}

const root = resolve(repo, target);
let run;
try {
  const { themeCheckRun } = await import("@shopify/theme-check-node");
  run = await themeCheckRun(root);
} catch (error) {
  console.error(`theme-check could not run: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(2);
}

const SEVERITY = { 0: "error", 1: "warning", 2: "info" };
const offenses = run.offenses
  .map((o) => ({
    file: relative(root, fileURLToPath(o.uri)),
    line: (o.start?.line ?? 0) + 1,
    column: (o.start?.character ?? 0) + 1,
    check: o.check,
    severity: SEVERITY[o.severity] ?? String(o.severity),
    message: o.message,
  }))
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.check.localeCompare(b.check));

const require = createRequire(import.meta.url);
const pkg = (name) => JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8"));
const bundledDocs = JSON.parse(readFileSync(join(dirname(require.resolve("@shopify/theme-check-docs-updater/package.json")), "data", "latest.json"), "utf8"));
const counts = { error: 0, warning: 0, info: 0 };
for (const o of offenses) counts[o.severity] = (counts[o.severity] ?? 0) + 1;
const report = {
  tool: { "@shopify/theme-check-node": pkg("@shopify/theme-check-node").version, "@shopify/theme-check-common": pkg("@shopify/theme-check-common").version },
  node: process.version,
  docs: flag("offline") ? { source: "bundled in @shopify/theme-check-docs-updater", revision: bundledDocs.revision } : { source: "downloaded by theme-check at run time, falling back to the bundled copy", bundledRevision: bundledDocs.revision },
  config: "theme-check:recommended (the folder's .theme-check.yml)",
  theme: target,
  filesChecked: run.theme.length,
  counts,
  offenses,
};

const lines = [`theme-check ${report.tool["@shopify/theme-check-node"]} on ${target} (node ${process.version}; docs ${flag("offline") ? `bundled revision ${bundledDocs.revision.slice(0, 7)}` : "online"})`];
for (const o of offenses) lines.push(`${o.file}:${o.line}:${o.column}  ${o.severity.padEnd(7)} ${o.check}  ${o.message}`);
lines.push(offenses.length === 0 ? `0 offenses in ${run.theme.length} files` : `${offenses.length} offense(s) in ${run.theme.length} files: ${counts.error} error, ${counts.warning} warning, ${counts.info} info`);
const text = lines.join("\n") + "\n";
process.stdout.write(text);

for (const [name, content] of [["json", JSON.stringify(report, null, 2) + "\n"], ["text", text]]) {
  const out = value(name);
  if (out) {
    mkdirSync(dirname(resolve(repo, out)), { recursive: true });
    writeFileSync(resolve(repo, out), content);
  }
}
process.exit(offenses.length === 0 ? 0 : 1);
