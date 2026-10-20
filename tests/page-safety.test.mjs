import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Static guards for page bugs that froze or misled the real page. There is no browser in `npm test`, so these read the
 * page sources and check the rules that, once broken, leave the whole tab frozen or the board silently out of date.
 */
const read = (name) => readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8");
const index = read("index.html");
const enhancements = read("enhancements.js");
const control = read("agent-control.js");

test("every page script parses (a syntax error blanks the page)", () => {
  const inline = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(inline.length >= 1);
  for (const [name, source] of [...inline.map((s, i) => [`index.html inline ${i}`, s]), ["enhancements.js", enhancements], ["agent-control.js", control]]) {
    assert.doesNotThrow(() => new Function(source), name);
  }
});

test("the observer that decorates the page cannot trigger itself in a microtask loop", () => {
  // Assigning textContent replaces child nodes even for identical text, which is a mutation the observer sees again.
  // Run on a timer (a macrotask cannot starve the page) and only write when the value differs.
  assert.match(control, /new MutationObserver\(\s*scheduleDecorate\s*\)/, "the observer must call the debounced function, never decorate inline");
  assert.match(control, /function scheduleDecorate\(\)[\s\S]*?setTimeout\(/);
  assert.match(control, /textContent !== ASSIGN_LABEL/);
  assert.match(control, /textContent !== NOTICE_TEXT/);
  assert.doesNotMatch(control, /new MutationObserver\(\s*\(\)\s*=>\s*\{[^}]*textContent\s*=/, "an inline observer callback that assigns textContent is the freeze bug");
});

test("row decoration does not wait for requestAnimationFrame, which never fires in a background tab", () => {
  assert.doesNotMatch(index, /MutationObserver\(\(\)=>requestAnimationFrame/);
  assert.match(index, /decorateTimer=setTimeout\(/);
});

test("start-up can neither hang on a native dialog nor stay locked", () => {
  const start = index.indexOf("async function initializeStorage()");
  const end = index.indexOf("function queueDatabaseSave", start);
  assert.ok(start > 0 && end > start);
  const body = index.slice(start, end);
  assert.doesNotMatch(body, /\bconfirm\(/, "a native confirm() can block the page forever when the browser does not show it");
  assert.match(body, /AbortController/, "reading the database needs a timeout");
  assert.match(body, /finally\{document\.body\.inert=false\}/, "the page must always be released");
  assert.match(index, /function safeBackup\(/, "a failed local backup must not abort start-up");
});

test("restoring from the browser cache sends the database's current version", () => {
  assert.match(index, /putDatabaseState\(\{\.\.\.cacheState,stateVersion:current\.state\?\.stateVersion\}\)/);
});

test("the hidden attribute really hides (a display rule on .toolbar used to defeat it)", () => {
  // The rule is injected by agent-control.js; it must win over `.toolbar{display:flex}` or the batch toolbar shows in every view.
  assert.match(control, /\[hidden\]\{display:none!important\}/);
  assert.match(index, /\.toolbar\{[^}]*display:flex/, "the rule that needs defeating is still there, which is why the fix must stay");
});

test("assigning a task cannot be double-submitted, and an execution task is not told to only analyse", () => {
  assert.match(control, /if \(assigning\) return;/);
  assert.match(control, /EXECUTION_TEMPLATE/);
  assert.match(control, /requirementDetails\(requirement\)/);
});

test("the board refreshes itself without disturbing dialogs, typing or hidden tabs", () => {
  assert.match(control, /\/api\/version/);
  assert.match(control, /document\.hidden/);
  assert.match(control, /\.modal-bg\.open/);
  assert.match(control, /setInterval\(pollForChanges/);
});

test("the agent status says installed-but-signed-out instead of 'not found'", () => {
  assert.match(control, /已安装，未登录/);
  assert.match(control, /agent\.installed/);
});
