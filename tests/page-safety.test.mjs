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
const dialogs = read("dialogs.js");
const settings = read("settings-panel.js");
const flow = read("analysis-flow.js");

test("every page script parses (a syntax error blanks the page)", () => {
  const inline = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(inline.length >= 1);
  for (const [name, source] of [...inline.map((s, i) => [`index.html inline ${i}`, s]), ["enhancements.js", enhancements], ["agent-control.js", control], ["dialogs.js", dialogs], ["settings-panel.js", settings], ["analysis-flow.js", flow]]) {
    assert.doesNotThrow(() => new Function(source), name);
  }
});

test("every script the page needs is loaded, in an order that works", () => {
  const order = [...index.matchAll(/<script src="\/([\w-]+\.js)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["dialogs.js", "enhancements.js", "agent-control.js", "analysis-flow.js", "settings-panel.js"]);
});

test("the page never uses the browser's own dialogs (they block everything when the browser does not show them)", () => {
  const withoutBlockComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [name, source] of [["index.html", index], ["enhancements.js", enhancements], ["agent-control.js", control], ["settings-panel.js", settings], ["analysis-flow.js", flow]]) {
    assert.doesNotMatch(withoutBlockComments(source), /(?<![.\w])(?:window\.)?(?:confirm|prompt|alert)\(/, `${name} calls a native dialog`);
  }
  for (const method of ["confirm", "prompt", "alert", "copyText"]) assert.match(dialogs, new RegExp(`\\b${method}\\(`));
});

test("a task can be stopped from the board, the AI list and the run detail", () => {
  assert.match(control, /data-stop-run/);
  assert.match(control, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/cancel/);
  assert.match(control, /const stopButtonHtml = /);
  assert.match(control, /已请求终止/, "the run detail says a stop is under way");
});

test("a requirement can really be deleted, one at a time or several, and 'delete' as a decision is not mistaken for it", () => {
  assert.match(control, /data-delete-req/);
  assert.match(control, /id = "delete-selected"/);
  assert.match(control, /method: "DELETE"/);
  assert.match(index, /delete:\["不做","delete"\]/);
  assert.doesNotMatch(index, /<option value="delete">删除<\/option>/);
});

test("analysis comes first and a person confirms it before anything is assigned", () => {
  // The model analysis is intercepted in the capture phase, before the page's own "分配并分析" handler.
  assert.match(flow, /document\.addEventListener\("click"[\s\S]*?\.assign-modal \[data-mode="analyze"\][\s\S]*?\}, true\);/);
  assert.match(flow, /\/analysis\/model/);
  assert.match(flow, /assign-from-analysis/);
  assert.match(flow, /\/api\/analysis\/engines/);
  assert.match(flow, /engines\.defaultEngine/, "a model by default when a key is set up, an Agent otherwise");
  assert.match(flow, /data-confirm-analysis/, "agent analyses get a confirm button on their cards");
  assert.match(flow, /new MutationObserver\([\s\S]*?setTimeout\(/, "the card decorating observer is debounced like the others");
});

test("splitting is judged before it is confirmed, by hand or by AI", () => {
  for (const route of ["/split/assess", "/split-drafts", "/api/split/evaluate", "/confirm"]) assert.ok(flow.includes(route), route);
  assert.match(flow, /不需要拆分/, "'no split needed' is shown as an answer");
  assert.match(flow, /evaluation\.verdict === "bad"/, "an unusable split cannot be confirmed");
  assert.match(flow, /STALE_DRAFT/);
  assert.match(flow, /\[data-split-requirement\][\s\S]*?stopImmediatePropagation/, "the old prompt-a-JSON-array button is replaced");
});

test("the result field of a collaboration task can be filled by a model, and says what to do without a key", () => {
  assert.match(flow, /data-ai-refine/);
  assert.match(flow, /record: false/);
  assert.match(flow, /还没有配置模型 Key/);
});

test("the settings page keeps secrets out of storage, URLs and logs", () => {
  assert.doesNotMatch(settings, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(settings, /console\.(log|info|debug)/);
  assert.doesNotMatch(settings, /URLSearchParams|location\.(search|hash)|\?\w+=\$\{/, "a key must never ride in a URL");
  assert.match(settings, /type="password"[^>]*autocomplete="new-password"/);
  assert.match(settings, /input\.value = "";/, "a secret field is emptied once saved");
  assert.match(settings, /method, path|send\("PUT"/, "keys are sent in a request body");
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
