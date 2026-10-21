// Builds the public site (GitHub Pages) from dist/cover.html: the cover becomes index.html, and the download buttons,
// version tags, file names and sizes are pointed at the release that was just published.
//
// The cover marks what changes with two attributes, so it stays a normal page when opened as it is (the links then go to
// the repository's "latest release" page):
//   <a data-release-link="exe|web|page" href="...">      -> href is replaced
//   <b data-release-text="version-tag|exe-name|...">x</b> -> the text inside is replaced
//
//   node scripts/render-site.mjs --out _site --repo owner/name --tag v0.1.57 --version 0.1.57 \
//        --exe Taskflow-Setup-0.1.57.exe --web Taskflow-Web-0.1.57.zip [--exe-size BYTES] [--web-size BYTES] [--date YYYY-MM-DD]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const LINK_MARKERS = ["exe", "web", "page"];
export const TEXT_MARKERS = ["version-tag", "exe-name", "exe-size", "web-size", "released"];

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** "约 98 MB" / "不到 1 MB"; undefined when the size is not known (the page keeps its default text). */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1024 * 1024 ? "不到 1 MB" : `约 ${Math.round(n / (1024 * 1024))} MB`;
}

/**
 * Pure: takes the cover's HTML and the facts of one release, returns the page for the public site.
 * Throws when an input could not safely go into a link or file name, or when the cover lost a marker it is expected to have
 * (so a renamed or deleted marker breaks the build instead of quietly publishing an old link).
 */
export function renderCover(html, { repo, tag, version, exe, web, exeSize, webSize, date }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error(`repo must look like owner/name, got "${repo}"`);
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error(`tag must look like v1.2.3, got "${tag}"`);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || `v${version}` !== tag) throw new Error(`version "${version}" does not match tag "${tag}"`);
  for (const [label, name] of [["exe", exe], ["web", web]]) if (!/^[\w.-]+$/.test(name ?? "")) throw new Error(`${label} file name is not a plain file name: "${name}"`);
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must look like 2026-10-21, got "${date}"`);

  const base = `https://github.com/${repo}`;
  const links = { exe: `${base}/releases/download/${tag}/${exe}`, web: `${base}/releases/download/${tag}/${web}`, page: `${base}/releases/tag/${tag}` };
  const texts = {
    "version-tag": `V${version}`, "exe-name": exe, "exe-size": formatSize(exeSize), "web-size": formatSize(webSize),
    released: date ? ` · 发布于 ${date}` : "",
  };

  const seen = new Set();
  let out = html.replace(/<a\b[^>]*\bdata-release-link="([\w-]+)"[^>]*>/g, (tagText, name) => {
    if (!links[name]) throw new Error(`unknown link marker data-release-link="${name}"`);
    seen.add(`link:${name}`);
    return tagText.replace(/\bhref="[^"]*"/, `href="${escapeHtml(links[name])}"`);
  });
  out = out.replace(/(<(\w+)\b[^>]*\bdata-release-text="([\w-]+)"[^>]*>)([^<]*)(<\/\2>)/g, (whole, open, element, name, current, close) => {
    if (!(name in texts)) throw new Error(`unknown text marker data-release-text="${name}"`);
    seen.add(`text:${name}`);
    return `${open}${texts[name] === undefined ? current : escapeHtml(texts[name])}${close}`;
  });
  const missing = [...LINK_MARKERS.map((n) => `link:${n}`), ...TEXT_MARKERS.map((n) => `text:${n}`)].filter((key) => !seen.has(key));
  if (missing.length) throw new Error(`the cover is missing marker(s): ${missing.join(", ")}`);
  return out;
}

function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" }, repo: { type: "string" }, tag: { type: "string" }, version: { type: "string" },
      exe: { type: "string" }, web: { type: "string" }, "exe-size": { type: "string" }, "web-size": { type: "string" }, date: { type: "string" },
      source: { type: "string", default: fileURLToPath(new URL("../dist/cover.html", import.meta.url)) },
    },
  });
  if (!values.out) throw new Error("--out is required");
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  const html = renderCover(readFileSync(values.source, "utf8"), {
    repo: values.repo, tag: values.tag, version: values.version, exe: values.exe, web: values.web,
    exeSize: values["exe-size"], webSize: values["web-size"], date,
  });
  mkdirSync(values.out, { recursive: true });
  writeFileSync(path.join(values.out, "index.html"), html, "utf8");
  copyFileSync(path.join(values.out, "index.html"), path.join(values.out, "404.html"));
  writeFileSync(path.join(values.out, ".nojekyll"), "", "utf8"); // publish the files as they are
  writeFileSync(path.join(values.out, "release.json"), `${JSON.stringify({
    version: values.version, tag: values.tag, date,
    exe: `https://github.com/${values.repo}/releases/download/${values.tag}/${values.exe}`,
    web: `https://github.com/${values.repo}/releases/download/${values.tag}/${values.web}`,
  }, null, 2)}\n`, "utf8");
  console.log(`Site for ${values.tag} written to ${values.out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`render-site: ${error.message}`); process.exitCode = 1; }
}
