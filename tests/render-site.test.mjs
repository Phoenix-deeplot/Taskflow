import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ciVersion } from "../scripts/ci-version.mjs";
import { formatSize, LINK_MARKERS, renderCover, TEXT_MARKERS } from "../scripts/render-site.mjs";

const cover = readFileSync(new URL("../dist/cover.html", import.meta.url), "utf8");
const root = fileURLToPath(new URL("..", import.meta.url));
const release = {
  repo: "Phoenix-deeplot/Taskflow", tag: "v0.1.57", version: "0.1.57", exe: "Taskflow-Setup-0.1.57.exe", web: "Taskflow-Web-0.1.57.zip",
  exeSize: 98 * 1024 * 1024 + 123, webSize: 400 * 1024, date: "2026-10-21",
};
const base = "https://github.com/Phoenix-deeplot/Taskflow/releases";

test("a new release replaces every download link, version tag, file name and size on the page", () => {
  const page = renderCover(cover, release);
  assert.ok(page.includes(`href="${base}/download/v0.1.57/Taskflow-Setup-0.1.57.exe"`));
  assert.ok(page.includes(`href="${base}/download/v0.1.57/Taskflow-Web-0.1.57.zip"`));
  assert.ok(page.includes(`href="${base}/tag/v0.1.57"`));
  assert.equal([...page.matchAll(/data-release-text="version-tag">V0\.1\.57</g)].length, 3, "the release line and both cards");
  assert.ok(page.includes('data-release-text="exe-name">Taskflow-Setup-0.1.57.exe<'));
  assert.ok(page.includes('data-release-text="exe-size">约 98 MB<'));
  assert.ok(page.includes('data-release-text="web-size">不到 1 MB<'));
  assert.ok(page.includes('data-release-text="released"> · 发布于 2026-10-21<'));
  assert.doesNotMatch(page, /releases\/latest/, "no default link survives");
  assert.doesNotMatch(page, /V0\.1\.0</, "no default version tag survives");
  // Everything else on the page is untouched, including the hand-kept backup links.
  assert.ok(page.includes("https://cloud.189.cn/web/share?code=RZNvYjQvqa2e"));
  assert.ok(page.includes("https://wwaps.lanzoue.com/isJvU4ctgxgb"));
  assert.equal(page.length - cover.length < 600, true);
});

test("the next release replaces the previous one's links, not just the defaults", () => {
  const first = renderCover(cover, release);
  const second = renderCover(first, { ...release, tag: "v0.1.58", version: "0.1.58", exe: "Taskflow-Setup-0.1.58.exe", web: "Taskflow-Web-0.1.58.zip" });
  assert.ok(second.includes("/download/v0.1.58/Taskflow-Setup-0.1.58.exe"));
  assert.doesNotMatch(second, /0\.1\.57/);
});

test("an unknown size keeps the page's own wording", () => {
  const page = renderCover(cover, { ...release, exeSize: undefined, webSize: undefined });
  assert.ok(page.includes('data-release-text="exe-size">约 100 MB<'));
  assert.equal(formatSize(undefined), undefined);
  assert.equal(formatSize("0"), undefined);
  assert.equal(formatSize(1024 * 1024), "约 1 MB");
});

test("a cover that lost a marker fails the build instead of publishing an old link", () => {
  for (const name of LINK_MARKERS) assert.throws(() => renderCover(cover.replaceAll(`data-release-link="${name}"`, 'data-x="y"'), release), new RegExp(`link:${name}`));
  for (const name of TEXT_MARKERS) assert.throws(() => renderCover(cover.replaceAll(`data-release-text="${name}"`, 'data-x="y"'), release), new RegExp(`text:${name}`));
  assert.throws(() => renderCover(cover.replace('data-release-link="exe"', 'data-release-link="exee"'), release), /unknown link marker/);
  assert.throws(() => renderCover(cover.replace('data-release-text="released"', 'data-release-text="released-at"'), release), /unknown text marker/);
});

test("nothing odd can be smuggled into a link or the page through the release facts", () => {
  const bad = (change, pattern) => assert.throws(() => renderCover(cover, { ...release, ...change }), pattern);
  bad({ repo: "evil/x\"><script>" }, /repo must look like/);
  bad({ repo: "no-slash" }, /repo must look like/);
  bad({ tag: "latest" }, /tag must look like/);
  bad({ tag: "v1.2.3", version: "1.2.4" }, /does not match tag/);
  bad({ exe: "a b.exe" }, /plain file name/);
  bad({ web: "../x.zip" }, /plain file name/);
  bad({ exe: "x\".exe" }, /plain file name/);
  bad({ date: "yesterday" }, /date must look like/);
});

test("the command line writes the site: index, 404, .nojekyll and release.json", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "site-"));
  try {
    execFileSync(process.execPath, ["scripts/render-site.mjs", "--out", out, "--repo", release.repo, "--tag", release.tag, "--version", release.version,
      "--exe", release.exe, "--web", release.web, "--exe-size", String(release.exeSize), "--web-size", String(release.webSize), "--date", release.date], { cwd: root, encoding: "utf8" });
    assert.ok(readFileSync(path.join(out, "index.html"), "utf8").includes("/download/v0.1.57/Taskflow-Setup-0.1.57.exe"));
    assert.equal(readFileSync(path.join(out, "404.html"), "utf8"), readFileSync(path.join(out, "index.html"), "utf8"));
    assert.ok(existsSync(path.join(out, ".nojekyll")));
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, "release.json"), "utf8")), {
      version: "0.1.57", tag: "v0.1.57", date: "2026-10-21", exe: `${base}/download/v0.1.57/${release.exe}`, web: `${base}/download/v0.1.57/${release.web}`,
    });
    assert.throws(() => execFileSync(process.execPath, ["scripts/render-site.mjs", "--out", out, "--repo", release.repo, "--tag", "bad", "--version", "x", "--exe", "a.exe", "--web", "a.zip"], { cwd: root, stdio: "pipe" }), /tag must look like/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("the version a run publishes is MAJOR.MINOR from package.json plus the run number", () => {
  assert.equal(ciVersion("0.1.0", 57), "0.1.57");
  assert.equal(ciVersion("2.10.3", "1"), "2.10.1");
  for (const run of ["0", "-1", "1.5", "abc", "", undefined]) assert.throws(() => ciVersion("0.1.0", run), /run number/);
  assert.throws(() => ciVersion("one", 1), /1\.2\.3/);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(execFileSync(process.execPath, ["scripts/ci-version.mjs", "42"], { cwd: root, encoding: "utf8" }).trim(), ciVersion(manifest.version, 42));
});
