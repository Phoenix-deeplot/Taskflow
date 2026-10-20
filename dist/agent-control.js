(() => {
  const api = window.WorkbenchAPI;
  if (!api) return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const style = document.createElement("style");
  style.textContent = `
    [hidden]{display:none!important}
    .agent-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 14px;background:#f8fbfb;border-bottom:1px solid #edf0f2;color:#60717c;font-size:11px}
    .agent-tools input,.agent-tools select{border:1px solid #dfe7ea;border-radius:6px;padding:6px 8px;font:inherit;background:white;color:#344b58}
    .agent-tools input{min-width:min(360px,60vw);flex:1}
    .agent-status{font-size:10px;color:#6c7d86}.agent-status.ok{color:#34755d}.agent-status.no{color:#a45c57}
    .agent-run-check{margin-right:6px;accent-color:#3e8077}.run-detail{max-height:60vh;overflow:auto;font-size:11px;color:#586b77}.run-detail pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f8;padding:10px;border-radius:7px;max-height:260px;overflow:auto}
    .run-timeline{padding:5px 0}.run-timeline div{border-left:2px solid #d9e6e4;padding:4px 0 7px 9px;margin-left:4px}.run-actions{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
    .assign-modal .modal{width:min(650px,100%)}.assign-modal textarea{min-height:180px}.assign-mode{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:13px}
  `;
  document.head.append(style);

  const assignModal = document.createElement("div");
  assignModal.className = "modal-bg assign-modal";
  assignModal.innerHTML = `<section class="modal"><div class="modal-head"><h2>分配 AI 任务</h2><button class="close" data-close>×</button></div>
    <p class="agent-status" data-assign-feature></p><div class="field-row"><div class="field"><label>执行器</label><select data-provider><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="manual_handoff">手动交接</option></select></div><div class="field"><label>负责人（可选）</label><input data-assignee placeholder="Claude Code / Codex / Wu"></div></div>
    <div class="field"><label>任务模板 / 指令（可编辑）</label><textarea data-template></textarea></div><div class="assign-mode"><button class="btn" data-mode="assign">只分配</button><button class="btn" data-mode="analyze">分配并分析</button><button class="btn primary" data-mode="execute">分配并执行</button></div></section>`;
  document.body.append(assignModal);

  const runModal = document.createElement("div");
  runModal.className = "modal-bg";
  runModal.id = "run-modal";
  runModal.innerHTML = `<section class="modal"><div class="modal-head"><h2 data-run-title>运行详情</h2><button class="close" data-close>×</button></div><div class="run-detail" data-run-content></div><div class="modal-foot"><span>自动刷新运行中的进度与日志</span><button class="btn" data-close>关闭</button></div></section>`;
  document.body.append(runModal);

  let selectedRequirementId = "";
  let selectedRunId = "";
  let runRefreshTimer = null;
  let cachedAgents = null;
  let cachedAgentsAt = 0;

  async function request(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
    return body;
  }
  const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body || {}) });

  async function reload() {
    await api.flush?.();
    await api.reloadDatabaseState?.();
  }
  function selectedProvider() { return $("[data-provider-current]")?.value || "claude"; }
  function providerSelect() { return `<select data-provider-current aria-label="执行器"><option value="claude">Claude Code</option><option value="codex">Codex</option></select>`; }
  async function agentStatus(force = false) {
    if (!force && cachedAgents && Date.now() - cachedAgentsAt < 30_000) return agentStatusHtml(cachedAgents);
    cachedAgents = await request("/api/agents");
    cachedAgentsAt = Date.now();
    return agentStatusHtml(cachedAgents);
  }
  // One agent: "可用", "已安装，未登录（怎么办）", or "未检测到（原因）" — never a bare "未检测到" for something that is installed.
  function oneAgentHtml(label, agent) {
    if (!agent) return `<span class="agent-status no">${label}：检测失败</span>`;
    const version = agent.version ? ` · ${esc(agent.version)}` : "";
    if (agent.available) return `<span class="agent-status ok">${label}：可用${version}${agent.mode ? `（${esc(agent.mode)}）` : ""}</span>`;
    if (agent.installed) return `<span class="agent-status no" title="${esc(agent.reason || "")}">${label}：已安装，未登录${version}<small> — ${esc(agent.reason || "请先登录")}</small></span>`;
    return `<span class="agent-status no" title="${esc(agent.reason || "")}">${label}：未检测到${agent.reason ? `<small> — ${esc(agent.reason)}</small>` : ""}</span>`;
  }
  function agentStatusHtml(result) {
    return `${oneAgentHtml("Claude Code", result.claude)}${oneAgentHtml("Codex", result.codex)}<button class="btn small" data-redetect>重新检测</button>`;
  }
  async function loadTools(container) {
    const settings = await request("/api/settings");
    container.querySelector("[data-project-path]").value = settings.projectPath || "";
    container.querySelector("[data-agent-status]").innerHTML = await agentStatus();
    container.querySelector("[data-save-project]").onclick = async () => {
      const input = container.querySelector("[data-project-path]");
      try { await request("/api/settings", { method: "PUT", body: JSON.stringify({ projectPath: input.value.trim() }) }); api.toast("当前项目目录已保存"); }
      catch (error) { api.toast(`保存失败：${error.message}`); }
    };
    container.addEventListener("click", async (event) => {
      if (!event.target.closest("[data-redetect]")) return;
      try { container.querySelector("[data-agent-status]").innerHTML = await agentStatus(true); }
      catch (error) { api.toast(`检测失败：${error.message}`); }
    });
  }
  function toolsMarkup() {
    return `<div class="agent-tools"><label for="agent-project">当前项目目录</label><input id="agent-project" data-project-path><button class="btn small" data-save-project>保存目录</button><div data-agent-status>正在检测本地 Agent…</div></div>`;
  }
  function addTools(panel) {
    let container = panel.querySelector("[data-agent-tools]");
    if (container) return;
    container = document.createElement("div");
    container.dataset.agentTools = "true";
    container.innerHTML = toolsMarkup();
    panel.prepend(container);
    void loadTools(container).catch((error) => { const status = container.querySelector("[data-agent-status]"); if (status) status.textContent = `Agent 检测失败：${error.message}`; });
  }
  function addAIBatchControls(panel) {
    if (panel.querySelector("[data-ai-batch]")) return;
    const controls = document.createElement("div");
    controls.className = "agent-tools";
    controls.dataset.aiBatch = "true";
    controls.innerHTML = `<b>本地 Agent</b>${providerSelect()}<button class="btn primary small" data-run-all-ai>执行全部待执行任务</button>`;
    panel.prepend(controls);
    controls.querySelector("[data-run-all-ai]").onclick = () => dispatchSelected([], $("[data-provider-current]", controls).value, "all");
    addTools(panel);
  }
  async function openAssign(requirementId) {
    selectedRequirementId = requirementId;
    const requirement = api.state.items.find((item) => item.id === requirementId);
    $assignTitle().textContent = requirement ? `${requirement.id} · ${requirement.title}` : requirementId;
    const textarea = $("[data-template]", assignModal);
    textarea.value = "正在读取默认任务模板…";
    assignModal.classList.add("open");
    try {
      const result = await request("/api/analysis-template");
      textarea.value = result.template || "请分析这项需求的用户价值、复杂度、风险与验收方式。";
      defaultAnalysisTemplate = textarea.value.trim();
    } catch (error) { textarea.value = `请分析这项需求的价值、实现复杂度、风险和验收方式。\n\n需求：${requirement?.title || ""}\n说明：${requirement?.description || ""}`; }
    $("[data-provider]", assignModal).value = "claude";
  }
  function $assignTitle() { return $("[data-assign-feature]", assignModal); }
  function closeAssign() { assignModal.classList.remove("open"); }
  // What an execution task says when the person did not write their own instruction. (The box in the dialog starts
  // with the analysis template, which says "do not modify any files" — wrong for a task that is meant to change code.)
  const EXECUTION_TEMPLATE = [
    "请在当前工作树中完成下面的需求。",
    "改动保持最小，风格与现有代码一致；不要修改与需求无关的文件。",
    "完成后运行项目已有的检查（如有），并说明：改了哪些文件、做了什么、哪些没有做、遇到的问题。",
  ].join("\n");
  let defaultAnalysisTemplate = "";
  function requirementDetails(requirement) {
    if (!requirement) return "";
    return ["—— 需求 ——", `需求：${requirement.title}`, `模块：${requirement.module || "未分类"}`, `目标版本：${requirement.targetVersion}`, `当前决策：${requirement.decision}${requirement.decisionNote ? `（${requirement.decisionNote}）` : ""}`, `说明：${requirement.description || "暂无"}`].join("\n");
  }
  let assigning = false;
  async function performAssign(mode) {
    if (assigning) return; // a double click must not create two tasks
    const requirementId = selectedRequirementId;
    const requirement = api.state.items.find((item) => item.id === requirementId);
    const provider = $("[data-provider]", assignModal).value;
    const template = $("[data-template]", assignModal).value.trim();
    const assignee = $("[data-assignee]", assignModal).value.trim();
    if (!template) { api.toast("任务说明不能为空"); return; }
    assigning = true;
    assignModal.querySelectorAll("button[data-mode]").forEach((button) => { button.disabled = true; });
    try {
      let task;
      if (mode === "analyze") {
        task = await post(`/api/requirements/${encodeURIComponent(requirementId)}/analysis`, { template, provider, executorType: provider, assignee: assignee || provider });
      } else {
        const instruction = !defaultAnalysisTemplate || template === defaultAnalysisTemplate ? EXECUTION_TEMPLATE : template;
        const taskText = `${instruction}\n\n${requirementDetails(requirement)}`.trim();
        task = await request("/api/tasks", { method: "POST", body: JSON.stringify({ requirementId, provider, executorType: mode === "execute" ? provider : "manual_handoff", assignee, taskText, acceptance: ["说明实际完成内容、关键依据和未解决问题"] }) });
      }
      closeAssign();
      if (mode !== "assign") {
        const dispatched = await post(`/api/tasks/${encodeURIComponent(task.id)}/dispatch`, { executorType: provider });
        await reload();
        api.toast(`任务已派发（Run ${dispatched.run?.id || "已创建"}）；由本地 Runner 执行`);
      } else {
        await reload();
        api.toast("AI 任务已分配");
      }
    } catch (error) {
      await reload().catch(() => {});
      api.toast(`操作失败：${error.message}`);
    } finally {
      assigning = false;
      assignModal.querySelectorAll("button[data-mode]").forEach((button) => { button.disabled = false; });
    }
  }
  async function dispatchSelected(taskIds, provider, mode = "selected") {
    if (mode !== "all" && !taskIds.length) { api.toast("先勾选至少一个待执行任务"); return; }
    try {
      const result = mode === "all" ? await post("/api/tasks/dispatch-all", { executorType: provider }) : await post("/api/tasks/dispatch", { taskIds, executorType: provider });
      await reload();
      const skipped = (result.results || []).filter((entry) => !entry.ok);
      const detail = skipped.slice(0, 3).map((entry) => `${entry.taskId}：${entry.message}`).join("；");
      api.toast(`批量派发完成：已派发 ${result.dispatched}，跳过 ${result.skipped || 0}${result.waiting ? `，其他状态等待 ${Object.values(result.waiting).reduce((a, b) => a + b, 0)} 项` : ""}${detail ? `。${detail}` : ""}`);
    } catch (error) { api.toast(`批量派发失败：${error.message}`); }
  }
  async function executeTask(taskId, provider) {
    try {
      const result = await post(`/api/tasks/${encodeURIComponent(taskId)}/dispatch`, { executorType: provider || selectedProvider() });
      await reload();
      api.toast(`已派发任务，等待 Runner 领取（Run ${result.run?.id || "已创建"}）`);
    } catch (error) { api.toast(`派发失败：${error.message}`); }
  }
  async function showRunDetail(taskId) {
    clearInterval(runRefreshTimer);
    const content = $("[data-run-content]", runModal);
    content.textContent = "正在读取运行信息…";
    runModal.classList.add("open");
    try {
      const task = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
      const run = (task.runs || []).slice().sort((a, b) => (b.attempt || 0) - (a.attempt || 0))[0];
      if (!run) { content.textContent = "此任务还没有 Run。先派发任务，再启动本地 Runner。"; return; }
      selectedRunId = run.id;
      $("[data-run-title]", runModal).textContent = `${task.id} · Run ${run.attempt || ""}`;
      const detail = await request(`/api/runs/${encodeURIComponent(run.id)}`);
      renderRunDetail(detail);
      if (["pending", "running"].includes(detail.run?.status)) runRefreshTimer = setInterval(() => refreshRunDetail(selectedRunId), 4000);
      else await reload();
    } catch (error) { content.textContent = `读取失败：${error.message}`; }
  }
  function formatElapsed(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    return s >= 3600 ? `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分` : s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
  }
  const HEARTBEAT_TEXT = { ok: "正常", slow: "偏慢", lost: "失联", ended: "已结束" };
  function renderRunDetail(detail) {
    const content = $("[data-run-content]", runModal);
    const run = detail.run || {};
    const began = Date.parse(run.claimedAt || run.startedAt || "");
    const finished = run.endedAt ? Date.parse(run.endedAt) : Date.now();
    const elapsed = Number.isFinite(began) ? formatElapsed((finished - began) / 1000) : "—";
    const running = run.status === "running";
    const progress = detail.progress ? `${detail.progress.pct ?? "—"}% · ${detail.progress.step || detail.progress.message || ""}` : "暂无进度事件";
    const heartbeat = detail.heartbeat ? `${HEARTBEAT_TEXT[detail.heartbeat.state] || detail.heartbeat.state}（${detail.heartbeat.ageSeconds ?? "—"} 秒前）` : "尚未由 Runner 领取";
    const quiet = running && detail.heartbeat?.state === "ok" && !detail.logTail
      ? "Agent 还在工作：Codex / Claude 在思考和执行时不会持续输出内容，一个任务可能需要几分钟。只要“心跳”显示正常就没有卡住。" : "";
    const workspace = detail.workspace || {};
    const where = [
      workspace.projectPath ? `项目：${esc(workspace.projectPath)}` : "",
      workspace.access ? `权限：${workspace.access === "read-only" ? "只读（不会修改文件）" : "只在独立分支里修改"}` : "",
      workspace.reportedBranch?.uri ? `分支：${esc(String(workspace.reportedBranch.uri).replace(/^git:/, ""))}` : "",
      workspace.diff ? `改动：<span class="module-tag" title="${esc(workspace.diff.uri)}">diff · ${workspace.diff.sizeBytes} 字节</span>` : "",
    ].filter(Boolean).join("　");
    const result = run.resultSummary ? `<h4>结果摘要</h4><pre>${esc(String(run.resultSummary).slice(0, 1200))}${String(run.resultSummary).length > 1200 ? "\n…（完整内容在任务卡片的“AI 输出 / 处理结果”和产物里）" : ""}</pre>` : "";
    const checks = (run.evidence || []).filter((e) => e.kind === "check").map((e) => `<span class="module-tag" style="${e.passed ? "" : "color:#a45c57"}">${esc(e.name)}：${e.passed ? "通过" : `缺少 ${esc((e.missing || []).join("、"))}`}</span>`).join(" ");
    content.innerHTML = `<div><b>当前阶段：</b>${esc(detail.phase || run.status)}<br><b>已运行：</b>${esc(elapsed)}${run.endedAt ? "（已结束）" : ""}<br><b>进度：</b>${esc(progress)}<br><b>心跳：</b>${esc(heartbeat)}<br><b>状态：</b>${esc(run.status || "")}</div>${quiet ? `<p class="dim">${esc(quiet)}</p>` : ""}${where ? `<p class="dim">${where}</p>` : ""}${detail.error ? `<p style="color:#a45c57"><b>${esc(detail.error.code || "ERROR")}</b> · ${esc(detail.error.message || "")}</p>` : ""}${checks ? `<p>${checks}</p>` : ""}${result}<div class="run-actions">${(detail.artifacts || []).map((a) => `<span class="module-tag" title="${esc(a.uri)}">${esc(a.kind)} · ${esc(a.metadata?.fileName || a.id)}</span>`).join("")}</div><h4>事件时间线</h4><div class="run-timeline">${(detail.timeline || []).slice().reverse().map((entry) => `<div>${esc(new Date(entry.at).toLocaleString())} · ${esc(entry.summary)}</div>`).join("") || "暂无事件"}</div><h4>最新日志（最多 8000 字）</h4><pre>${esc(detail.logTail || "暂无日志")}</pre><h4>执行尝试</h4><p>${(detail.attempts || []).map((attempt) => `#${attempt.attempt} ${attempt.status}`).map(esc).join("　") || "无"}</p>`;
  }
  async function refreshRunDetail(runId) {
    if (!runId || !runModal.classList.contains("open")) return;
    try {
      const detail = await request(`/api/runs/${encodeURIComponent(runId)}`);
      renderRunDetail(detail);
      if (!["pending", "running"].includes(detail.run?.status)) { clearInterval(runRefreshTimer); await reload(); }
    }
    catch (error) { clearInterval(runRefreshTimer); $("[data-run-content]", runModal).insertAdjacentHTML("afterbegin", `<p class="dim">自动刷新已停止：${esc(error.message)}</p>`); }
  }
  function closeRun() { clearInterval(runRefreshTimer); runModal.classList.remove("open"); }

  const originalBoardRender = window.renderTaskBoard;
  if (originalBoardRender) window.renderTaskBoard = function (...args) {
    const result = originalBoardRender.apply(this, args);
    const panel = $("#dynamic-panel");
    if (!panel) return result;
    const toolbar = document.createElement("div");
    toolbar.className = "agent-tools";
    toolbar.innerHTML = `<b>本地执行</b>${providerSelect()}<button class="btn small" data-dispatch-selected>执行所选</button><button class="btn small primary" data-dispatch-all>执行全部待执行</button><button class="btn small" data-refresh-agents>重新检测 Agent</button>`;
    panel.prepend(toolbar);
    const queued = panel.querySelectorAll("[data-start-task]");
    for (const button of queued) {
      const card = button.closest(".board-card");
      const taskId = button.dataset.startTask;
      if (!card) continue;
      card.querySelector("[data-start-task]")?.remove();
      const label = document.createElement("label"); label.title = "加入批量执行"; label.innerHTML = `<input class="agent-run-check" type="checkbox" data-select-run="${esc(taskId)}">选择`;
      card.prepend(label);
      const actions = document.createElement("div"); actions.className = "run-actions";
      actions.innerHTML = `<button class="btn primary small" data-execute-task="${esc(taskId)}">▶ 执行</button><button class="btn small" data-detail-task="${esc(taskId)}">运行详情</button>`;
      card.append(actions);
    }
    // Every card gets a way to see what its run is doing, not only the queued ones: a task that is running, waiting for
    // review or failed is exactly when you want the progress, the error and the log.
    for (const card of panel.querySelectorAll(".board-card")) {
      if (card.querySelector("[data-detail-task]")) continue;
      const taskId = card.querySelector("[data-transition]")?.dataset.transition;
      if (!taskId) continue;
      const actions = document.createElement("div"); actions.className = "run-actions";
      actions.innerHTML = `<button class="btn small" data-detail-task="${esc(taskId)}">运行详情</button>`;
      card.append(actions);
    }
    panel.querySelector("[data-dispatch-selected]").onclick = () => dispatchSelected([...panel.querySelectorAll("[data-select-run]:checked")].map((input) => input.dataset.selectRun), $("[data-provider-current]", panel).value);
    panel.querySelector("[data-dispatch-all]").onclick = () => dispatchSelected([], $("[data-provider-current]", panel).value, "all");
    panel.querySelector("[data-refresh-agents]").onclick = () => panel.querySelector("[data-agent-tools] [data-redetect]")?.click();
    panel.querySelectorAll("[data-execute-task]").forEach((button) => button.onclick = () => executeTask(button.dataset.executeTask, $("[data-provider-current]", panel).value));
    panel.querySelectorAll("[data-detail-task]").forEach((button) => button.onclick = () => showRunDetail(button.dataset.detailTask));
    addTools(panel);
    return result;
  };

  document.addEventListener("click", (event) => {
    const rowAssign = event.target.closest("[data-task]");
    if (rowAssign && rowAssign.closest("#rows")) { event.preventDefault(); event.stopImmediatePropagation(); openAssign(rowAssign.dataset.task); return; }
    const runDetailButton = event.target.closest("[data-run-history]");
    if (runDetailButton) { event.preventDefault(); event.stopImmediatePropagation(); showRunDetail(runDetailButton.dataset.runHistory); return; }
    const runTask = event.target.closest("[data-run-task]");
    if (runTask) { event.preventDefault(); event.stopImmediatePropagation(); executeTask(runTask.dataset.runTask); return; }
    const closeAssignButton = event.target.closest("[data-close]");
    if (closeAssignButton?.closest(".assign-modal")) closeAssign();
    if (closeAssignButton?.closest("#run-modal")) closeRun();
  }, true);
  assignModal.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");
    if (button) void performAssign(button.dataset.mode);
    if (event.target === assignModal) closeAssign();
  });
  runModal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeRun));
  runModal.addEventListener("click", (event) => { if (event.target === runModal) closeRun(); });

  // The board and AI-task views are re-rendered by the original page; add controls after each paint.
  // IMPORTANT: this callback changes the page, and the observer watches the page. Assigning textContent replaces the
  // child nodes even when the text is identical, which is itself a change that fires the observer again — a loop that
  // runs as microtasks and freezes the whole tab as soon as one requirement row exists. So: only write when the value
  // really differs, and run later on a timer (a macrotask can never starve the page).
  const ASSIGN_LABEL = "分配 AI";
  const ASSIGN_TITLE = "选择只分配、分配并分析或分配并执行";
  const NOTICE_TEXT = "通过本地 Runner 将任务交给 Claude Code 或 Codex；执行进度、日志和产物可在运行详情中查看。";
  let decorateScheduled = false;
  function scheduleDecorate() {
    if (decorateScheduled) return;
    decorateScheduled = true;
    setTimeout(() => { decorateScheduled = false; decorateAgentUi(); }, 0);
  }
  function decorateAgentUi() {
    document.querySelectorAll("#rows [data-task]").forEach((button) => {
      if (button.textContent !== ASSIGN_LABEL) button.textContent = ASSIGN_LABEL;
      if (button.title !== ASSIGN_TITLE) button.title = ASSIGN_TITLE;
    });
    const model = $("#task-model");
    if (model && !model.querySelector('option[value="codex"]')) model.insertAdjacentHTML("beforeend", '<option value="codex">Codex</option>');
    const notice = $(".notice-line");
    if (notice && notice.textContent !== NOTICE_TEXT) notice.textContent = NOTICE_TEXT;
    document.querySelectorAll(".task-card").forEach((card) => {
      const edit = card.querySelector("[data-task-edit]");
      if (!edit || card.querySelector("[data-run-history]")) return;
      const id = edit.dataset.taskEdit;
      const actions = card.querySelector(".task-right");
      if (actions) {
        const detail = document.createElement("button"); detail.type = "button"; detail.className = "btn small"; detail.dataset.runHistory = id; detail.textContent = "运行详情"; actions.append(detail);
        const select = document.createElement("select"); select.className = "task-status"; select.dataset.providerCurrent = ""; select.innerHTML = '<option value="claude">Claude Code</option><option value="codex">Codex</option>'; actions.append(select);
      }
    });
    document.querySelectorAll("[data-run-task]").forEach((button) => { if (button.dataset.realBound) return; button.dataset.realBound = "1"; button.addEventListener("click", (event) => { event.preventDefault(); event.stopImmediatePropagation(); const card = button.closest(".task-card"); executeTask(button.dataset.runTask, $("[data-provider-current]", card)?.value); }, true); });
    const aiPanel = $("#dynamic-panel");
    if (aiPanel?.querySelector(".ai-card-list")) addAIBatchControls(aiPanel);
  }
  const observer = new MutationObserver(scheduleDecorate);
  observer.observe(document.body, { childList: true, subtree: true });

  // Keep the board honest: a run changes the server's state long after you clicked, so check a tiny endpoint every few
  // seconds and reload only when the version moved. Never while a dialog is open or you are typing, and not in a hidden tab.
  let pollingChanges = false;
  async function pollForChanges() {
    if (pollingChanges || document.hidden) return;
    if (document.querySelector(".modal-bg.open, .overlay.open") || document.activeElement?.matches?.("input, textarea, select")) return;
    pollingChanges = true;
    try {
      const { stateVersion } = await request("/api/version");
      if (Number.isInteger(stateVersion) && stateVersion !== api.state.stateVersion) await reload();
    } catch { /* the server may be restarting; the next tick tries again */ }
    finally { pollingChanges = false; }
  }
  setInterval(pollForChanges, 3000);
  document.querySelectorAll("#rows [data-task]").forEach((button) => { button.textContent = "分配 AI"; button.title = "选择只分配、分配并分析或分配并执行"; });
  const model = $("#task-model");
  if (model && !model.querySelector('option[value="codex"]')) model.insertAdjacentHTML("beforeend", '<option value="codex">Codex</option>');
  const notice = $(".notice-line");
  if (notice) notice.textContent = "通过本地 Runner 将任务交给 Claude Code 或 Codex；执行进度、日志和产物可在运行详情中查看。";
})();
