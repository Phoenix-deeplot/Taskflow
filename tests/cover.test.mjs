import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LINK_MARKERS, TEXT_MARKERS } from "../scripts/render-site.mjs";

/**
 * dist/cover.html is the product guide. It is also the home page of the public site (GitHub Pages, renamed index.html by
 * scripts/render-site.mjs), where none of the app exists, so it must stand alone. Its download buttons carry markers that the
 * release workflow rewrites to the newest release; the values written in the file are only defaults.
 */
const cover = readFileSync(new URL("../dist/cover.html", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tags = (pattern) => [...cover.matchAll(pattern)].map((match) => match[0]);
const REPO = "Phoenix-deeplot/Taskflow";

test("the cover's script parses", () => {
  const scripts = [...cover.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
});

test("the cover needs nothing from another site; it links to itself, the workbench, this repository's releases and the two backup drives", () => {
  assert.doesNotMatch(cover, /<script[^>]+src=/);
  assert.doesNotMatch(cover, /<link[^>]+rel="stylesheet"/);
  assert.doesNotMatch(cover, /\ssrc="https?:/);
  const hrefs = [...cover.matchAll(/href="([^"]+)"/g)].map((match) => match[1]).filter((href) => !href.startsWith("data:"));
  assert.ok(hrefs.length > 10);
  const allowed = [
    /^#[\w-]+$/, /^\.\/index\.html$/,
    new RegExp(`^https://github\\.com/${REPO}/releases(/latest|/tag/v\\d+\\.\\d+\\.\\d+|/download/v\\d+\\.\\d+\\.\\d+/[\\w.-]+)?$`),
    /^https:\/\/(cloud\.189\.cn|wwaps\.lanzoue\.com)\/[\w./?=&%-]*$/, // backup downloads kept by hand
  ];
  for (const href of hrefs) assert.ok(allowed.some((pattern) => pattern.test(href)), `unexpected link: ${href}`);
  for (const tag of tags(/<a [^>]*href="https:[^"]*"[^>]*>/g)) assert.match(tag, /rel="noopener"/, `${tag} opens another site: it must say rel="noopener"`);
});

test("every in-page anchor points at an element that exists", () => {
  const ids = new Set([...cover.matchAll(/\sid="([\w-]+)"/g)].map((match) => match[1]));
  for (const [, target] of cover.matchAll(/href="#([\w-]+)"/g)) assert.ok(ids.has(target), `no element with id="${target}"`);
});

test("on the public site only the downloads are offered; the workbench link is for the local app and starts hidden", () => {
  const toWorkbench = tags(/<a [^>]*href="\.\/index\.html"[^>]*>/g);
  assert.ok(toWorkbench.length >= 3);
  for (const tag of toWorkbench) assert.match(tag, /data-local[^>]*\shidden|data-local\s+hidden/, `${tag} must be local-only and hidden until the script decides`);
  for (const tag of tags(/<a [^>]*href="https:\/\/github\.com\/[^"]*"[^>]*>/g)) assert.match(tag, /data-public|data-release-link/, `${tag} is a download and must disappear inside the local app`);
  assert.match(cover, /\["127\.0\.0\.1", "localhost", "\[::1\]"\]\.includes\(location\.hostname\)/);
});

test("every marker the release build rewrites is there, and its default is a safe link to the latest release", () => {
  for (const name of LINK_MARKERS) assert.ok(cover.includes(`data-release-link="${name}"`), `missing data-release-link="${name}"`);
  for (const name of TEXT_MARKERS) assert.ok(cover.includes(`data-release-text="${name}"`), `missing data-release-text="${name}"`);
  for (const tag of tags(/<a [^>]*data-release-link="[^"]+"[^>]*>/g)) {
    assert.match(tag, new RegExp(`href="https://github\\.com/${REPO}/releases/latest"`), `${tag}: the default must be the repository's latest release`);
    assert.match(tag, /target="_blank"/);
  }
});

test("the defaults on the page name the version in package.json and the files the build scripts produce", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(cover.includes(`data-release-text="exe-name">Taskflow-Setup-${manifest.version}.exe<`), "electron-builder is set to name the installer Taskflow-Setup-<version>.exe");
  assert.equal(manifest.build.nsis.artifactName, "Taskflow-Setup-${version}.${ext}");
  assert.ok(cover.includes(`data-release-text="version-tag">V${manifest.version}<`));
  const packager = readFileSync(new URL("../scripts/package-taskflow.mjs", import.meta.url), "utf8");
  assert.match(packager, /`Taskflow-Web-\$\{manifest\.version\}`/);
  assert.match(packager, /`\$\{packageName\}\.zip`/);
  assert.doesNotMatch(cover, /DESKTOP_DOWNLOAD|dl-desktop-|downloads\//, "the network-drive mechanism and the downloads/ folder are gone");
});

test("the cover says what it takes to run: Git, an Agent CLI, Node for the portable package, and that the build is unsigned", () => {
  for (const phrase of ["Git", "Node.js 22.13", "未代码签名", "start-taskflow.cmd", "127.0.0.1:4179", "%LOCALAPPDATA%\\Taskflow\\data"]) assert.ok(cover.includes(phrase), `missing: ${phrase}`);
});
