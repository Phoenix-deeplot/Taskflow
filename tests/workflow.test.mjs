import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * The release workflow cannot run here, so these tests pin down the things that, once wrong, only show up after a push:
 * what triggers it, what it is allowed to do, that every file name it expects is one the build produces, and that the
 * home page it publishes is the cover.
 */
const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const { default: yaml } = await import("js-yaml").catch(() => ({ default: null })); // a transitive dependency; the text checks below still run without it
const workflow = yaml ? yaml.load(source) : null;
const stepsOf = (job) => workflow.jobs[job].steps;

test("the workflow is valid YAML with the three jobs it needs", { skip: !yaml }, () => {
  assert.deepEqual(Object.keys(workflow.jobs), ["gate", "build", "site"]);
  assert.equal(workflow.jobs.build.needs, "gate");
  assert.equal(workflow.jobs.site.needs, "build", "the site is only rebuilt after a release exists");
});

test("it runs on a push to main (and by hand), one at a time", { skip: !yaml }, () => {
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.ok("workflow_dispatch" in workflow.on);
  assert.equal(workflow.on.push.tags, undefined, "pushing the release's own tag must not start another release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false, "never cancel a release half-way");
  assert.equal(workflow.jobs.build.if, "${{ needs.gate.outputs.publish == 'true' }}");
});

// This is the bug the first push hit: a commit message that merely MENTIONED the switch skipped the whole release.
// The decision is made by the real script from the workflow, run with the commit message in the environment, as GitHub does.
// A bash that passes environment variables through and understands C:/ paths (Git Bash, as GitHub's Windows runners use).
// Windows may also have WSL's bash.exe first on PATH, which does neither, so each candidate is probed.
const gitRoot = (() => {
  const run = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  return run.status === 0 ? path.resolve(run.stdout.trim(), "../../..") : null; // <root>/mingw64/libexec/git-core on Git for Windows
})();
const bash = [gitRoot && path.join(gitRoot, "bin", "bash.exe"), "C:/Program Files/Git/bin/bash.exe", "bash"].filter(Boolean).find((candidate) => {
  const probe = spawnSync(candidate, ["-c", 'echo "$PROBE"'], { env: { ...process.env, PROBE: "ok" }, encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() === "ok";
});
const bashAvailable = Boolean(bash);
function decide({ event = "push", message }) {
  const script = workflow.jobs.gate.steps.find((step) => step.id === "decide").run;
  const directory = mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const output = path.join(directory, "output.txt").replaceAll("\\", "/");
  try {
    writeFileSync(output, "");
    const run = spawnSync(bash, ["-c", script], { env: { ...process.env, EVENT: event, MESSAGE: message, GITHUB_OUTPUT: output }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(output, "utf8").trim();
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("[skip release] in the first line stops a release; anywhere else it is only text", { skip: !yaml || !bashAvailable }, () => {
  assert.equal(decide({ message: "docs: typo [skip release]\n\nlonger explanation" }), "publish=false");
  assert.equal(decide({ message: "[skip release] wip" }), "publish=false");
  assert.equal(decide({ message: "ci: publish a release on every push\n\n- put [skip release] in a commit message to push without publishing." }), "publish=true", "mentioning it in the body does not trip it");
  assert.equal(decide({ message: "ci: ok\n[skip release]" }), "publish=true", "second line");
  assert.equal(decide({ message: "feat: normal change" }), "publish=true");
  assert.equal(decide({ message: "" }), "publish=true");
  assert.equal(decide({ event: "workflow_dispatch", message: "docs: x [skip release]" }), "publish=true", "starting it by hand always publishes");
});

test("the commit message reaches the script through the environment, not by being pasted into it", { skip: !yaml }, () => {
  const step = workflow.jobs.gate.steps.find((entry) => entry.id === "decide");
  assert.equal(step.env.MESSAGE, "${{ github.event.head_commit.message }}");
  assert.doesNotMatch(step.run, /\$\{\{/);
});

test("permissions are the least that work: read by default, write only where a release or a deploy needs it", { skip: !yaml }, () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.build.permissions, { contents: "write" });
  assert.deepEqual(workflow.jobs.site.permissions, { contents: "read", pages: "write", "id-token": "write" });
  assert.equal(workflow.jobs.site.environment.name, "github-pages");
});

test("the build job tests first, stamps the version, builds exe then zip, checks the files, and only then publishes", { skip: !yaml }, () => {
  const names = stepsOf("build").map((step) => step.name || step.uses);
  const order = ["Install dependencies", "Run the tests", "Work out the version", "Stamp the version into the build", "Build the Windows installer", "Build the portable web package", "Check the files and write checksums", "Publish the release"];
  const positions = order.map((name) => names.indexOf(name));
  assert.ok(positions.every((index) => index >= 0), `missing step: ${order.filter((_, i) => positions[i] < 0)}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "steps are in this order");
  assert.equal(stepsOf("build").find((step) => step.name === "Run the tests").run, "npm test");
  assert.equal(workflow.jobs.build["runs-on"], "windows-latest", "the installer is a Windows build");
});

test("the file names the workflow expects are the ones electron-builder and the zip script produce", () => {
  assert.equal(manifest.build.nsis.artifactName, "Taskflow-Setup-${version}.${ext}");
  assert.match(source, /exe="Taskflow-Setup-\$VERSION\.exe"/);
  assert.match(source, /web="Taskflow-Web-\$VERSION\.zip"/);
  assert.match(source, /electron-builder --win nsis --x64 --publish never/);
  assert.match(source, /npm run pack:taskflow/);
  assert.equal(manifest.scripts["pack:taskflow"], "node scripts/package-taskflow.mjs");
  assert.equal(manifest.build.directories.output, "release");
  assert.match(source, /npm version "\$VERSION" --no-git-tag-version/, "both artifacts read their version from package.json");
});

test("the release carries both files and the checksums, and a re-run replaces files instead of failing on the tag", () => {
  assert.match(source, /gh release create "\$TAG" "\$\{files\[@\]\}" --target "\$COMMIT"/);
  assert.match(source, /gh release upload "\$TAG" "\$\{files\[@\]\}" --clobber/);
  for (const file of ["Taskflow-Setup-$VERSION.exe", "Taskflow-Web-$VERSION.zip", "SHA256SUMS.txt"]) assert.ok(source.includes(`release/${file}`), file);
  assert.match(source, /github\.token/);
  assert.doesNotMatch(source, /secrets\./, "nothing here needs a secret: the built-in token is enough");
});

test("the site is the cover rendered with the new release's links, published through the official Pages actions", () => {
  assert.match(source, /node scripts\/render-site\.mjs --out _site/);
  for (const flag of ["--repo", "--tag", "--version", "--exe", "--web", "--exe-size", "--web-size", "--date"]) assert.ok(source.includes(flag), flag);
  assert.match(source, /uses: actions\/configure-pages@v5/);
  assert.match(source, /uses: actions\/upload-pages-artifact@v3\s+with:\s+path: _site/);
  assert.match(source, /uses: actions\/deploy-pages@v4/);
  assert.ok(source.indexOf("configure-pages") < source.indexOf("upload-pages-artifact") && source.indexOf("upload-pages-artifact") < source.indexOf("deploy-pages"));
});

test("values from the outside reach the shell only through environment variables, never pasted into the script", () => {
  const scripts = [...source.matchAll(/^\s+run: (?:\|\n((?:\s{10,}.*\n?)+)|>\n((?:\s{10,}.*\n?)+)|(.+))$/gm)].map((match) => match[1] ?? match[2] ?? match[3]);
  assert.ok(scripts.length >= 8);
  for (const script of scripts) assert.doesNotMatch(script, /\$\{\{/, `an expression is pasted into a script:\n${script}`);
});

test("every action is pinned to a major version", () => {
  const uses = [...source.matchAll(/uses: ([\w./-]+)@(\S+)/g)];
  assert.ok(uses.length >= 7);
  for (const [, action, ref] of uses) assert.match(ref, /^v\d+$/, `${action}@${ref}`);
});
