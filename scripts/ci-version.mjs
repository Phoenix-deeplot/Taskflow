// The version a CI run publishes: the MAJOR.MINOR written in package.json plus the workflow run number as the patch,
// e.g. package.json "0.1.0" + run 57 -> "0.1.57". The run number only ever goes up, so every push gets a new, ordered version
// without anyone editing a file. To start a new series (0.2.x), change package.json to 0.2.0.
//
//   node scripts/ci-version.mjs <run number>        prints the version
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function ciVersion(baseVersion, runNumber) {
  const base = /^(\d+)\.(\d+)\.\d+/.exec(String(baseVersion));
  if (!base) throw new Error(`package.json version must look like 1.2.3, got "${baseVersion}"`);
  if (!/^[1-9]\d*$/.test(String(runNumber))) throw new Error(`the run number must be a positive whole number, got "${runNumber}"`);
  return `${base[1]}.${base[2]}.${runNumber}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  process.stdout.write(`${ciVersion(manifest.version, process.argv[2])}\n`);
}
