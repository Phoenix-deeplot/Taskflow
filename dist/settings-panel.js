// Settings: how Claude Code signs in, which agents exist, and the keys for the model interface.
//
// Secrets typed here go to the local server and nowhere else. The server keeps them in its own file (never in the
// database, exports or backups) and never sends them back: this page can only ever see "configured" and the last four
// characters. A secret field is emptied the moment it is saved.
(() => {
  const api = window.WorkbenchAPI;
  if (!api) return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const style = document.createElement("style");
  style.textContent = `
    .settings-modal .modal{width:min(780px,100%);max-height:88vh;overflow:auto}
    .settings-modal h3{font-size:13px;margin:20px 0 6px;color:#254c63;border-bottom:1px solid #edf0f2;padding-bottom:6px}
    .settings-modal h3:first-of-type{margin-top:4px}
    .settings-modal .set-note{font-size:11px;color:#7d8b94;line-height:1.7;margin:4px 0 8px}
    .settings-modal .set-row{display:grid;grid-template-columns:150px 120px minmax(0,1fr) auto auto;gap:8px;align-items:center;margin:7px 0;font-size:12px}
    .settings-modal .set-row label{color:#526471;font-weight:600}
    .settings-modal .set-row input,.settings-modal .set-form input,.settings-modal .set-form textarea{border:1px solid #dfe7ea;border-radius:7px;padding:7px 9px;font:12px ui-monospace,monospace;color:#344a59;width:100%;min-width:0}
    .settings-modal .set-state{font-size:11px;color:#8e9aa1}.settings-modal .set-state.ok{color:#34755d}
    .settings-modal .set-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
    .settings-modal .agent-line{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 10px;border:1px solid #edf0f2;border-radius:8px;margin:6px 0;font-size:12px}
    .settings-modal .agent-line b{min-width:90px}.settings-modal .agent-line code{color:#61727e;font-size:11px;flex:1;min-width:120px;overflow-wrap:anywhere}
    .settings-modal .set-form{border:1px dashed #cfdde2;border-radius:9px;padding:12px;margin:8px 0;background:#fafcfc}
    .settings-modal .set-form .field{margin-bottom:10px}.settings-modal .set-form textarea{min-height:70px;resize:vertical}
    @media(max-width:650px){.settings-modal .set-row{grid-template-columns:1fr 1fr}}
  `;
  document.head.append(style);

  const modal = document.createElement("div");
  modal.className = "modal-bg settings-modal";
  modal.id = "settings-modal";
  modal.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="modal-head"><h2 id="settings-title">设置</h2><button class="close" data-close aria-label="关闭">×</button></div>
    <div data-settings-body><p class="set-note">正在读取…</p></div>
    <div class="modal-foot"><span>密钥只保存在这台电脑的本地服务里，不进数据库、备份和导出，也不会再显示出来。</span><button class="btn" data-close>完成</button></div>
  </section>`;
  document.body.append(modal);
  const body = $("[data-settings-body]", modal);

  async function request(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
    return result;
  }
  const send = (method, path, payload) => request(path, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const changed = () => window.dispatchEvent(new CustomEvent("wb:agents-changed"));

  let config = { keys: {}, customAgents: [] };
  let loginPolling = null;
  let editing = null; // null = no form, "" = new agent, otherwise the id being edited

  // ---------- pieces ----------
  function keyRow(slot, label, { secret = true, placeholder = "" } = {}) {
    const entry = config.keys[slot] || {};
    const state = entry.configured ? `已配置${secret && entry.hint ? ` ${esc(entry.hint)}` : ""}` : "未配置";
    const input = secret
      ? `<input type="password" autocomplete="new-password" spellcheck="false" placeholder="${esc(placeholder || "粘贴后点保存")}" data-key-input>`
      : `<input type="text" spellcheck="false" value="${esc(entry.value || "")}" placeholder="${esc(placeholder)}" data-key-input>`;
    return `<div class="set-row" data-slot="${esc(slot)}"><label>${esc(label)}</label><span class="set-state ${entry.configured ? "ok" : ""}">${state}</span>${input}<button class="btn small" data-save-key>保存</button>${entry.configured ? '<button class="btn small danger" data-clear-key>清除</button>' : "<span></span>"}</div>`;
  }
  const agentLine = (agent) => `<div class="agent-line" data-agent-id="${esc(agent.id)}"><b>${esc(agent.name)}</b><code>${esc([agent.command, ...(agent.args || [])].join(" "))}</code><span class="set-state" data-agent-state="${esc(agent.id)}"></span><button class="btn small" data-edit-agent>编辑</button><button class="btn small danger" data-delete-agent>删除</button></div>`;

  function agentForm(agent) {
    const isNew = editing === "" || editing === "__preset_deepseek_harness__";
    const secretSlot = `custom:${agent.id}`;
    const secretState = !isNew && config.keys[secretSlot]?.configured ? `（已配置 ${esc(config.keys[secretSlot].hint || "")}，留空表示不改）` : "";
    return `<div class="set-form" data-agent-form>
      <div class="field-row"><div class="field"><label>名称</label><input data-f="name" value="${esc(agent.name || "")}" placeholder="例如 Aider"></div>
      <div class="field"><label>标识（小写英文，创建后不能改）</label><input data-f="id" value="${esc(agent.id)}" placeholder="aider" ${isNew ? "" : "disabled"}></div></div>
      <div class="field"><label>命令（程序名或完整路径）</label><input data-f="command" value="${esc(agent.command || "")}" placeholder="${editing === "__preset_deepseek_harness__" ? "填写本机 DeepSeek Harness 的实际启动命令" : "aider  或  C:\\tools\\aider.exe"}"></div>
      <div class="field"><label>参数（每行一个，可留空）</label><textarea data-f="args" placeholder="--yes&#10;--message-file&#10;{promptFile}">${esc((agent.args || []).join("\n"))}</textarea></div>
      <p class="set-note">默认把任务说明从标准输入交给程序。参数里可以写：<code>{prompt}</code> 任务说明原文，<code>{promptFile}</code> 存有任务说明的文件路径，<code>{workspace}</code> 工作目录。程序打印出来的内容就是执行结果；它在独立分支的工作目录里运行。</p>
      <div class="field-row"><div class="field"><label>密钥环境变量名（可选）</label><input data-f="secretEnv" value="${esc(agent.secretEnv || "")}" placeholder="例如 OPENAI_API_KEY"></div>
      <div class="field"><label>密钥（可选）${secretState}</label><input type="password" autocomplete="new-password" spellcheck="false" data-f="secret" placeholder="只在运行这个 Agent 时交给它"></div></div>
      <div class="set-actions"><button class="btn primary small" data-save-agent>${isNew ? "添加" : "保存"}</button><button class="btn small" data-cancel-agent>取消</button></div>
    </div>`;
  }

  function render() {
    const claudeToken = keyRow("claude-code-token", "订阅令牌", { placeholder: "claude setup-token 生成的令牌" });
    const claudeKey = keyRow("claude-code-api-key", "Anthropic API Key", { placeholder: "sk-ant-…（按量计费）" });
    const editingAgent = editing === null ? null : editing === "" ? { id: "", name: "", command: "", args: [], secretEnv: "" } : editing === "__preset_deepseek_harness__" ? { id: "deepseek-harness", name: "DeepSeek Harness", command: "", args: [], secretEnv: "" } : config.customAgents.find((agent) => agent.id === editing);
    body.innerHTML = `
      <h3>Claude Code</h3>
      <div class="set-actions"><span data-status="claude" class="agent-status">正在检测…</span><button class="btn small primary" data-login-claude>登录 Claude Code</button><button class="btn small" data-redetect-settings>重新检测</button></div>
      <p class="set-note">命令行里的 <code>claude</code> 要单独登录一次——Claude 桌面应用里的登录不能给它用。点“登录 Claude Code”会打开浏览器，授权后回来点“重新检测”。也可以不登录，改填下面的令牌或 API Key（填一项即可，保存后立刻生效）。</p>
      ${claudeToken}${claudeKey}
      <h3>Codex</h3>
      <div class="set-actions"><span data-status="codex" class="agent-status">正在检测…</span></div>
      <p class="set-note">Codex 使用它自己的登录：在 Codex 应用（或终端 <code>codex login</code>）里登录即可，这里不需要密钥。</p>
      <h3>我添加的 Agent</h3>
      <p class="set-note">任何能在命令行里读任务说明、改文件的程序都可以加进来，加完后就出现在“分配 AI”的执行器列表里。DeepSeek Harness 先按自定义 Agent 接入，命令由你按本机安装填写。</p>
      ${config.customAgents.length ? config.customAgents.map(agentLine).join("") : '<p class="set-note">还没有添加。</p>'}
      ${editingAgent ? agentForm(editingAgent) : '<div class="set-actions"><button class="btn small" data-new-agent>＋ 添加 Agent</button><button class="btn small" data-preset-deepseek>＋ 添加 DeepSeek Harness</button></div>'}
      <h3>模型接口（智能拆分需求，可选）</h3>
      <p class="set-note">这些只用于“让模型把需求拆成任务”，由本地服务直接调用；不影响 Claude Code / Codex 的执行。</p>
      ${keyRow("anthropic-api-key", "Claude API Key")}${keyRow("anthropic-model", "Claude 模型名", { secret: false, placeholder: "模型名" })}
      ${keyRow("openai-api-key", "OpenAI API Key")}${keyRow("openai-model", "OpenAI 模型名", { secret: false, placeholder: "模型名" })}
      ${keyRow("deepseek-api-key", "DeepSeek API Key")}${keyRow("deepseek-model", "DeepSeek 模型名", { secret: false, placeholder: "例如 deepseek-chat" })}`;
    void refreshStatus();
  }

  const statusText = (label, agent) => {
    if (!agent) return `<span class="agent-status no">${label}：检测失败</span>`;
    const version = agent.version ? ` · ${esc(agent.version)}` : "";
    if (agent.available) return `<span class="agent-status ok">${label}：可用${version}${agent.mode ? `（${esc(agent.mode)}）` : ""}</span>`;
    if (agent.installed) return `<span class="agent-status no">${label}：已安装，未登录${version}<br><small>${esc(agent.reason || "")}</small></span>`;
    return `<span class="agent-status no">${label}：未检测到<small> — ${esc(agent.reason || "")}</small></span>`;
  };
  let statusToken = 0;
  async function refreshStatus() {
    const token = ++statusToken;
    try {
      const result = await request("/api/agents");
      if (token !== statusToken || !modal.classList.contains("open")) return result;
      const claude = $('[data-status="claude"]', body); if (claude) claude.outerHTML = statusText("Claude Code", result.claude).replace("<span ", '<span data-status="claude" ');
      const codex = $('[data-status="codex"]', body); if (codex) codex.outerHTML = statusText("Codex", result.codex).replace("<span ", '<span data-status="codex" ');
      for (const agent of result.custom || []) {
        const cell = $(`[data-agent-state="${CSS.escape(agent.id)}"]`, body);
        if (cell) { cell.textContent = agent.available === false ? `不可用：${agent.reason || ""}` : "可用"; cell.className = `set-state ${agent.available === false ? "" : "ok"}`; }
      }
      return result;
    } catch (error) {
      const claude = $('[data-status="claude"]', body); if (claude) claude.textContent = `检测失败：${error.message}`;
      return null;
    }
  }

  async function load() {
    try { config = await request("/api/agent-config"); }
    catch (error) { body.innerHTML = `<p class="set-note">读取设置失败：${esc(error.message)}。本地服务可能需要重启才有这一页。</p>`; return; }
    render();
  }

  // ---------- actions ----------
  async function saveKey(row) {
    const slot = row.dataset.slot;
    const input = $("[data-key-input]", row);
    const value = input.value.trim();
    if (!value) { api.toast("先填写内容再保存"); return; }
    try {
      const entry = await send("PUT", `/api/agent-config/keys/${encodeURIComponent(slot)}`, { value });
      input.value = "";
      config.keys[slot] = entry;
      render();
      api.toast("已保存");
      changed();
    } catch (error) { api.toast(`保存失败：${error.message}`); }
  }
  async function clearKey(row) {
    const slot = row.dataset.slot;
    const ok = await window.WBDialog.confirm("清除这项设置？", { okText: "清除", danger: true });
    if (!ok) return;
    try {
      const entry = await send("DELETE", `/api/agent-config/keys/${encodeURIComponent(slot)}`);
      config.keys[slot] = entry;
      render();
      api.toast("已清除");
      changed();
    } catch (error) { api.toast(`清除失败：${error.message}`); }
  }

  async function loginClaude() {
    try {
      const result = await send("POST", "/api/agents/claude/login", {});
      api.toast(result.message || "已打开浏览器登录页");
      // Check every few seconds for a while, so the status turns green by itself once the person finishes in the browser.
      clearInterval(loginPolling);
      let tries = 0;
      loginPolling = setInterval(async () => {
        tries += 1;
        const result = modal.classList.contains("open") ? await refreshStatus() : null;
        if (result?.claude?.available || tries >= 60 || !modal.classList.contains("open")) { clearInterval(loginPolling); if (result?.claude?.available) changed(); }
      }, 3000);
    } catch (error) { api.toast(`无法发起登录：${error.message}`); }
  }

  const slugFrom = (text) => String(text).split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 24);
  async function saveAgent() {
    const form = $("[data-agent-form]", body);
    const get = (name) => $(`[data-f="${name}"]`, form).value;
    const isNew = editing === "" || editing === "__preset_deepseek_harness__";
    const command = get("command").trim();
    const id = isNew ? (get("id").trim() || slugFrom(command)) : editing;
    const agent = {
      id, name: get("name").trim() || id, command,
      args: get("args").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      secretEnv: get("secretEnv").trim(),
    };
    if (!command) { api.toast("请填写本机 DeepSeek Harness（或自定义 Agent）的启动命令"); return; }
    const secret = get("secret").trim();
    if (agent.secretEnv && !secret && !(config.keys[`custom:${id}`]?.configured)) { api.toast("填了环境变量名，也要填密钥（或者清空环境变量名）"); return; }
    const list = isNew ? [...config.customAgents, agent] : config.customAgents.map((entry) => (entry.id === id ? agent : entry));
    try {
      const saved = await send("PUT", "/api/agent-config/custom-agents", { agents: list });
      config.customAgents = saved.customAgents;
      if (secret) config.keys[`custom:${id}`] = await send("PUT", `/api/agent-config/keys/${encodeURIComponent(`custom:${id}`)}`, { value: secret });
      editing = null;
      render();
      api.toast(isNew ? "Agent 已添加，可在“分配 AI”里选择" : "Agent 已保存");
      changed();
    } catch (error) { api.toast(`保存失败：${error.message}`); }
  }
  async function deleteAgent(id) {
    const agent = config.customAgents.find((entry) => entry.id === id);
    const ok = await window.WBDialog.confirm(`删除 Agent“${agent?.name || id}”？\n它的密钥也会一起删除。已经派发给它的任务需要重新分配。`, { okText: "删除", danger: true });
    if (!ok) return;
    try {
      const saved = await send("PUT", "/api/agent-config/custom-agents", { agents: config.customAgents.filter((entry) => entry.id !== id) });
      config.customAgents = saved.customAgents;
      delete config.keys[`custom:${id}`];
      if (editing === id) editing = null;
      render();
      api.toast("已删除");
      changed();
    } catch (error) { api.toast(`删除失败：${error.message}`); }
  }

  // ---------- opening and closing ----------
  function open() { editing = null; modal.classList.add("open"); body.innerHTML = '<p class="set-note">正在读取…</p>'; void load(); }
  function close() { clearInterval(loginPolling); statusToken += 1; modal.classList.remove("open"); }

  modal.addEventListener("click", (event) => {
    if (event.target === modal) { close(); return; }
    if (event.target.closest("[data-close]")) { close(); return; }
    const row = event.target.closest(".set-row");
    if (event.target.closest("[data-save-key]") && row) { void saveKey(row); return; }
    if (event.target.closest("[data-clear-key]") && row) { void clearKey(row); return; }
    if (event.target.closest("[data-login-claude]")) { void loginClaude(); return; }
    if (event.target.closest("[data-redetect-settings]")) { void refreshStatus().then(changed); return; }
    if (event.target.closest("[data-new-agent]")) { editing = ""; render(); return; }
    if (event.target.closest("[data-preset-deepseek]")) {
      if (config.customAgents.some((agent) => agent.id === "deepseek-harness")) { api.toast("DeepSeek Harness 已添加，请编辑现有配置"); return; }
      editing = "__preset_deepseek_harness__";
      render();
      const form = $("[data-agent-form]", body);
      $("[data-f=\"name\"]", form).value = "DeepSeek Harness";
      $("[data-f=\"id\"]", form).value = "deepseek-harness";
      return;
    }
    if (event.target.closest("[data-cancel-agent]")) { editing = null; render(); return; }
    if (event.target.closest("[data-save-agent]")) { void saveAgent(); return; }
    const line = event.target.closest("[data-agent-id]");
    if (line && event.target.closest("[data-edit-agent]")) { editing = line.dataset.agentId; render(); return; }
    if (line && event.target.closest("[data-delete-agent]")) { void deleteAgent(line.dataset.agentId); }
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.querySelector(".wbd-bg")) close();
    else if (event.key === "Enter" && event.target.matches?.("[data-key-input]")) { event.preventDefault(); void saveKey(event.target.closest(".set-row")); }
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("#settings-nav, [data-open-settings]")) { event.preventDefault(); open(); }
  });
})();
