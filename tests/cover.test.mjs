import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * dist/cover.html is the product guide. It is also uploaded on its own (renamed index.html, with the two packages in
 * downloads/) to a static host that has none of the app, so it must stand alone and must not link to anything that is
 * missing there.
 */
const cover = readFileSync(new URL("../dist/cover.html", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tags = (pattern) => [...cover.matchAll(pattern)].map((match) => match[0]);

test("the cover's script parses", () => {
  const scripts = [...cover.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
});

test("the cover needs nothing from another site and links only to itself, the workbench and the downloads", () => {
  assert.doesNotMatch(cover, /<script[^>]+src=/);
  assert.doesNotMatch(cover, /<link[^>]+rel="stylesheet"/);
  assert.doesNotMatch(cover, /(?:src|href)="https?:/);
  const hrefs = [...cover.matchAll(/href="([^"]+)"/g)].map((match) => match[1]).filter((href) => !href.startsWith("data:"));
  assert.ok(hrefs.length > 10);
  for (const href of hrefs) assert.match(href, /^(#[\w-]+|\.\/index\.html|\.\/downloads\/[^/]+)$/, `unexpected link: ${href}`);
});

test("every in-page anchor points at an element that exists", () => {
  const ids = new Set([...cover.matchAll(/\sid="([\w-]+)"/g)].map((match) => match[1]));
  for (const [, target] of cover.matchAll(/href="#([\w-]+)"/g)) assert.ok(ids.has(target), `no element with id="${target}"`);
});

test("on the public site only the downloads are offered; the workbench link is for the local app and starts hidden", () => {
  const toWorkbench = tags(/<a [^>]*href="\.\/index\.html"[^>]*>/g);
  assert.ok(toWorkbench.length >= 3);
  for (const tag of toWorkbench) assert.match(tag, /data-local[^>]*\shidden|data-local\s+hidden/, `${tag} must be local-only and hidden until the script decides`);
  for (const tag of tags(/<a [^>]*href="\.\/downloads\/[^"]+"[^>]*>/g)) assert.match(tag, /data-public/, `${tag} must disappear inside the local app, where nothing is served from downloads/`);
  assert.match(cover, /\["127\.0\.0\.1", "localhost", "\[::1\]"\]\.includes\(location\.hostname\)/);
});

test("the download part names the version package.json builds, and the two packages the build scripts produce", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(cover.includes(`<code>Taskflow Setup ${manifest.version}.exe</code>`), "electron-builder names the installer 'Taskflow Setup <version>.exe'");
  assert.ok(cover.includes(`./downloads/Taskflow-Web-${manifest.version}.zip`), "scripts/package-taskflow.mjs names the portable package Taskflow-Web-<version>.zip");
  assert.ok(cover.includes(`V${manifest.version}`));
  assert.doesNotMatch(cover, /downloads\/[^"]*\.exe/, "the installer is shared from a network drive, not from the static host");
});

test("the installer's network-drive link is filled in one place, must be https, and shows 'coming soon' until then", () => {
  const url = /const DESKTOP_DOWNLOAD_URL = "([^"]*)";/.exec(cover);
  const code = /const DESKTOP_DOWNLOAD_CODE = "([^"]*)";/.exec(cover);
  assert.ok(url && code, "the two constants the page owner edits must exist");
  assert.match(url[1], /^(https:\/\/\S+)?$/, "empty, or an https:// link");
  assert.match(cover, /if \(\/\^https:\\\/\\\/\/\.test\(DESKTOP_DOWNLOAD_URL\)\)/, "the script refuses anything that is not https");
  for (const id of ["dl-desktop-link", "dl-desktop-code", "dl-desktop-soon"]) assert.ok(cover.includes(`id="${id}"`), id);
  assert.match(cover, /<a [^>]*id="dl-desktop-link"[^>]*\shidden/, "no link until one is configured");
  assert.doesNotMatch(cover, /<a [^>]*id="dl-desktop-link"[^>]*\shref=/, "the href is only ever set by the script, from the constant");
  assert.match(cover, /安装包的网盘链接即将提供/);
});

test("the network-drive button works end to end: configured -> link, code and no 'coming soon'; empty -> only 'coming soon'", () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(cover)[1];
  const run = ({ url, code, hostname = "example.com" }) => {
    const nodes = Object.fromEntries(["dl-desktop-link", "dl-desktop-code", "dl-desktop-soon"].map((id) => [id, { hidden: id !== "dl-desktop-soon" ? true : false, textContent: "", href: "" }]));
    const stub = () => ({ addEventListener() {}, setAttribute() {}, classList: { add() {}, toggle: () => false, remove() {} }, contains: () => false });
    const document = {
      documentElement: { classList: { add() {} } },
      getElementById: (id) => nodes[id] || stub(),
      querySelectorAll: () => [],
    };
    const patched = script.replace('const DESKTOP_DOWNLOAD_URL = "";', `const DESKTOP_DOWNLOAD_URL = ${JSON.stringify(url)};`).replace('const DESKTOP_DOWNLOAD_CODE = "";', `const DESKTOP_DOWNLOAD_CODE = ${JSON.stringify(code)};`);
    new Function("document", "location", "window", "IntersectionObserver", patched)(document, { hostname }, { matchMedia: () => ({ matches: true }) }, undefined);
    return nodes;
  };
  const filled = run({ url: "https://pan.example.com/s/abc", code: "k3f9" });
  assert.equal(filled["dl-desktop-link"].href, "https://pan.example.com/s/abc");
  assert.equal(filled["dl-desktop-link"].hidden, false);
  assert.equal(filled["dl-desktop-soon"].hidden, true);
  assert.equal(filled["dl-desktop-code"].textContent, "提取码：k3f9");
  assert.equal(filled["dl-desktop-code"].hidden, false);
  const noCode = run({ url: "https://pan.example.com/s/abc", code: "" });
  assert.equal(noCode["dl-desktop-code"].hidden, true);
  for (const bad of ["", "http://pan.example.com/s/abc", "javascript:alert(1)", "//pan.example.com"]) {
    const nodes = run({ url: bad, code: "x" });
    assert.equal(nodes["dl-desktop-link"].hidden, true, `${bad || "(empty)"} must not become a link`);
    assert.equal(nodes["dl-desktop-link"].href, "");
    assert.equal(nodes["dl-desktop-soon"].hidden, false);
  }
});

test("the cover says what it takes to run: Git, an Agent CLI, Node for the portable package, and that the build is unsigned", () => {
  for (const phrase of ["Git", "Node.js 22.13", "未代码签名", "start-taskflow.cmd", "127.0.0.1:4179", "%LOCALAPPDATA%\\Taskflow\\data"]) assert.ok(cover.includes(phrase), `missing: ${phrase}`);
});
