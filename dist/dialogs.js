// In-page replacements for window.confirm / prompt / alert.
//
// The browser's own dialogs are synchronous and modal: when the browser (or an embedded browser pane) does not show them
// the whole page waits forever, and they cannot be styled or tested. These are ordinary elements and return promises.
//   await WBDialog.confirm("确定删除？", { danger: true, okText: "删除" })   -> true / false
//   await WBDialog.prompt("填写原因", { value: "", multiline: false })      -> string, or null when cancelled
//   await WBDialog.alert("导入失败：…")                                      -> undefined
//   await WBDialog.copyText("复制以下内容", text)                            -> shows the text with a copy button
(() => {
  if (window.WBDialog) return;
  const style = document.createElement("style");
  style.textContent = `
    .wbd-bg{position:fixed;inset:0;background:#102b3b66;z-index:40;display:grid;place-items:center;padding:15px}
    .wbd{width:min(520px,100%);background:#fff;border-radius:12px;padding:20px;box-shadow:0 20px 80px #102b3b45;max-height:90vh;display:flex;flex-direction:column}
    .wbd h2{font-size:15px;margin:0 0 10px}.wbd .wbd-body{font-size:13px;line-height:1.7;color:#344a59;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:50vh}
    .wbd textarea,.wbd input{width:100%;margin-top:10px;border:1px solid #dfe7ea;border-radius:7px;padding:9px 10px;font:12px/1.6 ui-monospace,monospace;color:#344a59}
    .wbd textarea{min-height:170px;resize:vertical}.wbd .wbd-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
    .wbd .btn.danger-fill{background:#a95e57;border-color:#a95e57;color:#fff}
  `;
  document.head.append(style);

  let chain = Promise.resolve();
  /** One dialog at a time: a second request waits for the first to close. */
  function show(build) {
    const run = () => new Promise((resolve) => {
      const background = document.createElement("div");
      background.className = "wbd-bg";
      const box = document.createElement("section");
      box.className = "wbd";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      background.append(box);
      const previouslyFocused = document.activeElement;
      const close = (value) => {
        document.removeEventListener("keydown", onKey, true);
        background.remove();
        previouslyFocused?.focus?.();
        resolve(value);
      };
      const controls = build(box, close);
      function onKey(event) {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(controls.cancelValue); }
        else if (event.key === "Enter" && controls.enterValue !== undefined && !(event.target instanceof HTMLTextAreaElement) && !event.isComposing) {
          event.preventDefault(); event.stopPropagation(); close(typeof controls.enterValue === "function" ? controls.enterValue() : controls.enterValue);
        }
      }
      document.addEventListener("keydown", onKey, true);
      background.addEventListener("mousedown", (event) => { if (event.target === background && controls.dismissable !== false) close(controls.cancelValue); });
      document.body.append(background);
      controls.focus?.focus?.();
    });
    const result = chain.then(run, run);
    chain = result.then(() => {}, () => {});
    return result;
  }
  const element = (tag, props = {}, text = "") => Object.assign(document.createElement(tag), props, text ? { textContent: text } : {});
  function footer(box, buttons) {
    const foot = element("div", { className: "wbd-foot" });
    for (const button of buttons) foot.append(button);
    box.append(foot);
  }

  window.WBDialog = {
    confirm(message, { title = "请确认", okText = "确定", cancelText = "取消", danger = false } = {}) {
      return show((box, close) => {
        box.append(element("h2", {}, title), element("div", { className: "wbd-body" }, String(message)));
        const cancel = element("button", { type: "button", className: "btn" }, cancelText);
        const ok = element("button", { type: "button", className: `btn ${danger ? "danger-fill" : "primary"}` }, okText);
        cancel.onclick = () => close(false);
        ok.onclick = () => close(true);
        footer(box, [cancel, ok]);
        return { cancelValue: false, enterValue: true, focus: danger ? cancel : ok };
      });
    },
    alert(message, { title = "提示", okText = "知道了" } = {}) {
      return show((box, close) => {
        box.append(element("h2", {}, title), element("div", { className: "wbd-body" }, String(message)));
        const ok = element("button", { type: "button", className: "btn primary" }, okText);
        ok.onclick = () => close(undefined);
        footer(box, [ok]);
        return { cancelValue: undefined, enterValue: undefined, focus: ok };
      });
    },
    prompt(message, { title = "请填写", value = "", multiline = false, okText = "确定", cancelText = "取消", placeholder = "" } = {}) {
      return show((box, close) => {
        box.append(element("h2", {}, title), element("div", { className: "wbd-body" }, String(message)));
        const field = multiline ? element("textarea", { value, placeholder, spellcheck: false }) : element("input", { type: "text", value, placeholder });
        box.append(field);
        const cancel = element("button", { type: "button", className: "btn" }, cancelText);
        const ok = element("button", { type: "button", className: "btn primary" }, okText);
        cancel.onclick = () => close(null);
        ok.onclick = () => close(field.value);
        footer(box, [cancel, ok]);
        return { cancelValue: null, enterValue: multiline ? undefined : () => field.value, focus: field };
      });
    },
    copyText(title, text) {
      return show((box, close) => {
        box.append(element("h2", {}, title));
        const field = element("textarea", { value: String(text), readOnly: true, spellcheck: false });
        box.append(field);
        const copy = element("button", { type: "button", className: "btn" }, "复制");
        const done = element("button", { type: "button", className: "btn primary" }, "关闭");
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(field.value); copy.textContent = "已复制"; }
          catch { field.select(); copy.textContent = "已选中，请按 Ctrl+C"; }
        };
        done.onclick = () => close(undefined);
        footer(box, [copy, done]);
        return { cancelValue: undefined, enterValue: undefined, focus: field };
      });
    },
  };
})();
