import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findSecrets } from "./provider.mjs";

/**
 * A short, read-only picture of the project a requirement is about, so a model can answer about THIS project instead of
 * giving a generic answer: the README's opening, the folder layout two levels deep, and what package.json says it runs.
 *
 * Everything is size-capped, nothing is written, files that usually hold credentials are never opened, and the result is
 * checked for credential-looking text before it can leave the machine (the part that trips the check is dropped, not sent).
 */
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".next", ".vinext", "dist", "build", "out", "coverage", "data", "work", ".wrangler", ".codex", ".agents", ".sites-runtime", "outputs", "__pycache__", ".venv", "venv", ".idea", ".vscode"]);
const SKIP_FILES = /^(\.env.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|.*\.sqlite.*|.*\.db|.*\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const MAX_ENTRIES = 160;
const README_CHARS = 3500;

function listTree(root, depth, entries) {
  const walk = (directory, level, prefix) => {
    let names;
    try { names = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of names) {
      if (entries.length >= MAX_ENTRIES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        entries.push(`${prefix}${entry.name}/`);
        if (level + 1 < depth) walk(path.join(directory, entry.name), level + 1, `${prefix}${entry.name}/`);
      } else if (!SKIP_FILES.test(entry.name)) {
        entries.push(`${prefix}${entry.name}`);
      }
    }
  };
  walk(root, 0, "");
}

const readText = (file, max) => {
  try {
    if (statSync(file).size > 2_000_000) return "";
    return readFileSync(file, "utf8").slice(0, max);
  } catch { return ""; }
};

/** Returns `{ name, readme, tree, scripts, dependencies, omitted? }`, or `null` when the folder cannot be read at all. */
export function readProjectOverview(projectPath) {
  let info;
  try { info = statSync(projectPath); } catch { return null; }
  if (!info.isDirectory()) return null;

  const tree = [];
  listTree(projectPath, 2, tree);
  let readme = "";
  for (const name of ["README.md", "readme.md", "README.MD", "README.txt", "README"]) {
    readme = readText(path.join(projectPath, name), README_CHARS);
    if (readme) break;
  }
  let scripts = [];
  let dependencies = [];
  let name = path.basename(projectPath);
  try {
    const pkg = JSON.parse(readText(path.join(projectPath, "package.json"), 200_000));
    name = pkg.name || name;
    scripts = Object.keys(pkg.scripts || {}).slice(0, 30);
    dependencies = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})].slice(0, 60);
  } catch { /* no package.json, or not JSON: the other parts still help */ }

  const overview = { name, readme, tree, scripts, dependencies };
  // Whatever looks like a credential does not leave the machine: drop the README first, then give up on the rest.
  if (findSecrets(JSON.stringify(overview))) {
    overview.readme = "";
    overview.omitted = "README 里疑似含有密钥，已不发送";
    if (findSecrets(JSON.stringify(overview))) return { name, readme: "", tree: [], scripts: [], dependencies: [], omitted: "项目概况里疑似含有密钥，整体未发送" };
  }
  return overview;
}
