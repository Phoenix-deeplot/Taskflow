// Analysis first, then assignment — and splitting that is judged before it is confirmed.
//
//  * "分配并分析": analyse with a model when a key is set up (it is told about the project), otherwise with an Agent. The
//    result is shown to a person, who may edit it, and only then does "确认并分配" create the task that carries it out.
//  * "拆分": an AI proposal (it may answer "no split needed") or a hand-written one, both shown with an evaluation, both
//    created only when a person confirms.
//  * "AI 分析并细化" in the collaboration-task dialog: fills the result field with a model's analysis.
(() => {
  const api = window.WorkbenchAPI;
  if (!api || !window.WBDialog) return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const lines = (text) => String(text).split(/\r?\n/).map((line) => line.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
  const csv = (text) => String(text).split(/[,，、\s]+/).map((part) => part.trim()).filter(Boolean);

  const style = document.createElement("style");
  style.textContent = `
    .flow-modal .modal{width:min(820px,100%);max-height:90vh;overflow:auto}
    .flow-meta{font-size:11px;color:#72818b;margin:0 0 10px;line-height:1.7}
    .flow-note{font-size:12px;border-radius:8px;padding:9px 11px;margin:8px 0;background:#f4f8f8;color:#3e5b66;line-height:1.7}
    .flow-note.warn{background:#fbf3e5;color:#8a6a2f}.flow-note.ok{background:#eaf5ef;color:#2f6b52}.flow-note.bad{background:#f8ecea;color:#a45c57}
    .flow-note button{margin-left:8px}
    .flow-modal pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f8;padding:10px;border-radius:7px;max-height:240px;overflow:auto;font-size:12px}
    .flow-modal details{margin:8px 0}.flow-modal summary{cursor:pointer;font-size:12px;color:#526471}
    .flow-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap;margin-top:14px}.flow-actions .grow{flex:1}
    .flow-modal textarea{min-height:110px}.flow-modal .field textarea.short{min-height:64px}
    .split-card{border:1px solid #e5eaed;border-radius:9px;padding:11px;margin:9px 0;background:#fbfcfc}
    .split-card-head{display:flex;gap:8px;align-items:center;margin-bottom:8px}.split-card-head input{flex:1;max-width:240px}
    .split-card .field-row{margin-top:8px}.split-card label{font-size:10px;color:#6a7a85;margin:4px 0 3px;display:block}
    .split-card textarea{min-height:64px}.split-card input,.split-card textarea{width:100%;border:1px solid #dfe7ea;border-radius:7px;padding:7px 9px;font:12px/1.6 inherit}
    .eval ul{margin:6px 0 0;padding-left:18px}.eval li.warn{color:#8a6a2f}.eval li.bad{color:#a45c57}.eval li.info{color:#5b7280}
    .split-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
    .split-tools select{border:1px solid #dfe7ea;border-radius:6px;padding:6px 8px;background:#fff}
    .engine-row{margin:6px 0 10px;padding:9px 11px;border:1px dashed #cfdde2;border-radius:8px;font-size:12px;color:#526471}
    .engine-row select{border:1px solid #dfe7ea;border-radius:6px;padding:5px 8px;margin:0 8px;background:#fff}
    .refine-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}.refine-row label{margin:0!important}
  `;
  document.head.append(style);

  async function request(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body.error || `${response.status} ${response.statusText}`); error.code = body.code; error.status = response.status; throw error; }
    return body;
  }
  const send = (method, path, payload) => request(path, { method, body: JSON.stringify(payload ?? {}) });
  async function reload() { await api.flush?.(); await api.reloadDatabaseState?.(); }
  const requirementOf = (id) => api.state.items.find((item) => item.id === id);

  // ---------- what can analyse: models with a key, Agents otherwise ----------
  let engines = { models: [], defaultEngine: "agent" };
  let customAgents = [];
  async function loadEngines() {
    try { engines = await request("/api/analysis/engines"); } catch { engines = { models: [], defaultEngine: "agent" }; }
    try { customAgents = (await request("/api/agent-config")).customAgents || []; } catch { customAgents = []; }
  }
  const executorOptions = (selected = "claude") => [["claude", "Claude Code"], ["codex", "Codex"], ...customAgents.map((agent) => [`custom:${agent.id}`, agent.name])]
    .map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`).join("");
  void loadEngines();
  window.addEventListener("wb:agents-changed", () => { void loadEngines().then(refreshEngineRow); });

  // ---------- "分配并分析": choose how it is analysed ----------
  const assignModal = $(".assign-modal");
  function engineChoices() {
    return [
      ...engines.models.map((model) => ({ value: `model:${model.name}`, label: `${model.label} 模型（${model.model}），约半分钟，会参考项目概况` })),
      { value: "agent:claude", label: "Claude Code（只读分析，可能要几分钟）" },
      { value: "agent:codex", label: "Codex（只读分析，可能要几分钟）" },
      ...customAgents.map((agent) => ({ value: `agent:custom:${agent.id}`, label: `${agent.name}（我添加的 Agent）` })),
    ];
  }
  function refreshEngineRow() {
    if (!assignModal) return;
    let row = $("[data-engine-row]", assignModal);
    if (!row) {
      row = document.createElement("div");
      row.className = "engine-row";
      row.dataset.engineRow = "true";
      $(".assign-mode", assignModal).before(row);
    }
    const keep = $("[data-engine]", row)?.value;
    const choices = engineChoices();
    const fallback = engines.defaultEngine === "agent" ? "agent:claude" : `model:${engines.defaultEngine}`;
    const chosen = choices.some((choice) => choice.value === keep) ? keep : fallback;
    row.innerHTML = `点“分配并分析”时，由<select data-engine>${choices.map((choice) => `<option value="${esc(choice.value)}" ${choice.value === chosen ? "selected" : ""}>${esc(choice.label)}</option>`).join("")}</select>
      <label data-project-label ${chosen.startsWith("model:") ? "" : "hidden"}><input type="checkbox" data-include-project checked> 附带项目概况（README、目录结构）</label>
      ${engines.models.length ? "" : '<div class="dim" style="margin-top:4px">没有配置模型 Key，默认由 Agent 分析。想用 DeepSeek 等模型，到“设置”里填 Key 和模型名。</div>'}`;
  }
  if (assignModal) {
    new MutationObserver(() => { if (assignModal.classList.contains("open")) refreshEngineRow(); }).observe(assignModal, { attributes: true, attributeFilter: ["class"] });
    assignModal.addEventListener("change", (event) => {
      if (!event.target.matches("[data-engine]")) return;
      const label = $("[data-project-label]", assignModal);
      if (label) label.hidden = !event.target.value.startsWith("model:");
    });
  }

  let analysing = false;
  function setAssignBusy(busy, message = "") {
    $$("button[data-mode]", assignModal).forEach((button) => { button.disabled = busy; });
    let note = $("[data-analyse-note]", assignModal);
    if (!note) { note = document.createElement("p"); note.className = "dim"; note.dataset.analyseNote = "true"; $(".assign-mode", assignModal).before(note); }
    note.textContent = message;
  }
  async function analyseWithModel(requirementId, engine, includeProject) {
    if (analysing) return;
    analysing = true;
    setAssignBusy(true, "模型正在分析这条需求（读取全局上下文、同模块需求、已有任务和项目概况），通常需要几十秒，请稍候…");
    try {
      const result = await send("POST", `/api/requirements/${encodeURIComponent(requirementId)}/analysis/model`, { engine, includeProject });
      assignModal.classList.remove("open");
      await reload();
      if (result.projectOmitted) api.toast(`注意：${result.projectOmitted}`);
      await openReview(result.task.id);
    } catch (error) {
      api.toast(`分析失败：${error.message}`);
    } finally { analysing = false; setAssignBusy(false, ""); }
  }
  // Capture phase, before the page's own handler: a model analysis is handled here; an Agent analysis is left to the
  // existing flow (we only point its executor drop-down at the Agent that was chosen).
  document.addEventListener("click", (event) => {
    const button = event.target.closest('.assign-modal [data-mode="analyze"]');
    if (!button) return;
    const choice = $("[data-engine]", assignModal)?.value || "agent:claude";
    if (choice.startsWith("agent:")) {
      const executor = $("[data-provider]", assignModal);
      if (executor) executor.value = choice.slice("agent:".length);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const requirementId = ($("[data-assign-feature]", assignModal)?.textContent || "").split(" · ")[0].trim();
    if (!requirementId) return;
    void analyseWithModel(requirementId, choice.slice("model:".length), $("[data-include-project]", assignModal)?.checked !== false);
  }, true);

  // ---------- reading an analysis, editing it, then assigning ----------
  const reviewModal = document.createElement("div");
  reviewModal.className = "modal-bg flow-modal";
  reviewModal.id = "analysis-review-modal";
  reviewModal.innerHTML = '<section class="modal" role="dialog" aria-modal="true"><div data-review-body></div></section>';
  document.body.append(reviewModal);
  const reviewBody = $("[data-review-body]", reviewModal);
  let review = null;

  const KIND_LABEL = { "model:deepseek": "DeepSeek 模型", "model:openai": "OpenAI 模型", "model:claude": "Claude 模型", claude: "Claude Code", codex: "Codex" };

  async function openReview(taskId) {
    try {
      await loadEngines();
      const task = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
      if (task.kind !== "analysis") { api.toast("这不是分析任务"); return; }
      if (task.status !== "review") { api.toast(`这条分析已经处理过了（状态：${task.status}）`); return; }
      const run = (task.runs || []).slice().reverse().find((entry) => entry.status === "succeeded");
      if (!run) { api.toast("这条分析还没有结果"); return; }
      const structured = (run.evidence || []).find((entry) => entry.kind === "analysis-json")?.data ?? null;
      const check = (run.evidence || []).find((entry) => entry.kind === "check");
      const requirement = requirementOf(task.requirementId);
      review = { taskId, requirementId: task.requirementId, text: run.resultSummary || "", structured, executorType: task.executorType };
      const by = KIND_LABEL[task.executorType] || (String(task.executorType).startsWith("custom:") ? "自定义 Agent" : task.executorType);
      const split = structured
        ? `<div class="flow-note ${structured.needsSplit.value ? "warn" : "ok"}">拆分判断：<b>${structured.needsSplit.value ? "需要拆分" : "不需要拆分"}</b>　${esc(structured.needsSplit.reason)}<button class="btn small" data-r-split>拆分任务…</button></div>`
        : '<div class="flow-note">这条需求要不要拆成多个任务？可以先让 AI 评估，也可以手工拆。<button class="btn small" data-r-split>拆分任务…</button></div>';
      const initialText = structured ? structured.refinedTaskText : review.text;
      const acceptance = structured?.acceptance?.length ? structured.acceptance : [];
      reviewBody.innerHTML = `
        <div class="modal-head"><h2>确认分析结果</h2><button class="close" data-close aria-label="关闭">×</button></div>
        <p class="flow-meta">需求：${esc(requirement ? `${requirement.id} · ${requirement.title}` : task.requirementId || "")}<br>
          分析方式：${esc(by)}${check ? `　格式检查：${check.passed ? "通过" : `缺少 ${esc((check.missing || []).join("、"))}`}` : ""}　<span class="dim">确认前不会改动需求的决策</span></p>
        ${split}
        ${structured ? `<details><summary>完整分析（结论、价值、复杂度、风险、V1 范围、待确认问题）</summary><pre>${esc(review.text)}</pre></details>` : ""}
        <div class="field"><label>分配给执行者的任务说明${structured ? "（模型细化的结果，可修改）" : "（Agent 的分析原文，可修改、删减）"}</label><textarea data-r-text>${esc(initialText)}</textarea></div>
        <div class="field"><label>验收标准（每行一条，可留空）</label><textarea class="short" data-r-accept>${esc(acceptance.join("\n"))}</textarea></div>
        <div class="field-row"><div class="field"><label>交给谁执行</label><select data-r-executor>${executorOptions("claude")}</select></div>
          <div class="field"><label>负责人（可选）</label><input data-r-assignee></div></div>
        <div class="flow-actions"><span class="grow dim">确认后，这条分析记为已验收，并按上面的内容建立新任务。</span>
          <button class="btn" data-close>先关闭，稍后再确认</button><button class="btn" data-r-assign>确认并只分配</button><button class="btn primary" data-r-execute>确认并分配执行</button></div>`;
      reviewModal.classList.add("open");
    } catch (error) { api.toast(`打开分析失败：${error.message}`); }
  }
  let confirming = false;
  async function confirmAnalysis(execute) {
    if (confirming || !review) return;
    const text = $("[data-r-text]", reviewBody).value.trim();
    if (!text) { api.toast("任务说明不能为空"); return; }
    confirming = true;
    $$("button", reviewBody).forEach((button) => { button.disabled = true; });
    const executor = $("[data-r-executor]", reviewBody).value;
    const { EXECUTION_TEMPLATE, requirementDetails } = window.WorkbenchAgentText || { EXECUTION_TEMPLATE: "", requirementDetails: () => "" };
    const composed = [EXECUTION_TEMPLATE, "—— 已确认的分析 ——", text, requirementDetails(requirementOf(review.requirementId))].filter(Boolean).join("\n\n");
    try {
      const assigned = await send("POST", `/api/tasks/${encodeURIComponent(review.taskId)}/assign-from-analysis`, {
        taskText: composed, acceptance: lines($("[data-r-accept]", reviewBody).value), executorType: execute ? executor : "manual_handoff",
        provider: executor, assignee: $("[data-r-assignee]", reviewBody).value.trim(),
      });
      reviewModal.classList.remove("open");
      if (execute) {
        try { await send("POST", `/api/tasks/${encodeURIComponent(assigned.task.id)}/dispatch`, { executorType: executor }); api.toast("分析已确认，任务已派发给执行者"); }
        catch (error) { api.toast(`分析已确认并建立了任务，但派发失败：${error.message}`); }
      } else api.toast("分析已确认，任务已分配（还没有开始执行）");
      await reload();
    } catch (error) {
      api.toast(`确认失败：${error.message}`);
      $$("button", reviewBody).forEach((button) => { button.disabled = false; });
    } finally { confirming = false; }
  }
  reviewModal.addEventListener("click", (event) => {
    if (event.target === reviewModal || event.target.closest("[data-close]")) { reviewModal.classList.remove("open"); return; }
    if (event.target.closest("[data-r-execute]")) { void confirmAnalysis(true); return; }
    if (event.target.closest("[data-r-assign]")) { void confirmAnalysis(false); return; }
    if (event.target.closest("[data-r-split]") && review) { const id = review.requirementId; reviewModal.classList.remove("open"); void openSplit(id); }
  });

  // "确认分析" on the cards of analyses waiting for a person.
  function decorateAnalysisCards() {
    for (const card of $$(".board-card, .task-card")) {
      if ($("[data-confirm-analysis]", card)) continue;
      const taskId = $("[data-transition]", card)?.dataset.transition || $("[data-task-edit]", card)?.dataset.taskEdit;
      const task = taskId && api.state.tasks.find((entry) => entry.id === taskId);
      if (!task || task.kind !== "analysis" || task.status !== "review") continue;
      const button = document.createElement("button");
      button.type = "button"; button.className = "btn primary small"; button.dataset.confirmAnalysis = taskId; button.textContent = "确认分析并分配";
      button.title = "查看分析结果，修改后确认，再分配给执行者";
      ($(".run-actions", card) || $(".task-right", card) || card).append(button);
    }
  }
  let decorateScheduled = false;
  new MutationObserver(() => {
    if (decorateScheduled) return;
    decorateScheduled = true;
    setTimeout(() => { decorateScheduled = false; decorateAnalysisCards(); injectRefineButton(); }, 0);
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-confirm-analysis]");
    if (button) { event.preventDefault(); event.stopImmediatePropagation(); void openReview(button.dataset.confirmAnalysis); }
  }, true);

  // ---------- splitting ----------
  const splitModal = document.createElement("div");
  splitModal.className = "modal-bg flow-modal";
  splitModal.id = "split-modal";
  splitModal.innerHTML = '<section class="modal" role="dialog" aria-modal="true"><div data-split-body></div></section>';
  document.body.append(splitModal);
  const splitBody = $("[data-split-body]", splitModal);
  let split = null; // { requirementId, draft, note }

  const VERDICT = { good: ["ok", "拆分合理"], warn: ["warn", "有提醒，确认前看一眼"], bad: ["bad", "还不能用"] };
  const cardHtml = (task = {}) => `<div class="split-card" data-split-card>
      <div class="split-card-head"><input data-s-key value="${esc(task.key || "")}" placeholder="标识，如 api"><button class="btn small danger" type="button" data-s-remove>删除这条</button></div>
      <textarea data-s-text placeholder="任务说明：做什么、不做什么、涉及哪里">${esc(task.taskText || "")}</textarea>
      <div class="field-row"><div><label>验收标准（每行一条，写到能判断做没做完）</label><textarea data-s-accept>${esc((task.acceptance || []).join("\n"))}</textarea></div>
        <div><label>必须先完成的任务（填它们的标识，逗号分隔）</label><input data-s-deps value="${esc((task.dependsOn || []).join(", "))}">
          <label>可能涉及的文件（逗号分隔，不确定就空着）</label><input data-s-scope value="${esc((task.fileScope || []).join(", "))}"></div></div></div>`;
  function collectTasks() {
    return $$("[data-split-card]", splitBody).map((card, index) => ({
      key: $("[data-s-key]", card).value.trim() || `step-${index + 1}`, taskText: $("[data-s-text]", card).value.trim(),
      acceptance: lines($("[data-s-accept]", card).value), dependsOn: csv($("[data-s-deps]", card).value), fileScope: csv($("[data-s-scope]", card).value), status: "queued",
    }));
  }
  function renderEvaluation(evaluation) {
    const box = $("[data-s-eval]", splitBody);
    if (!box) return;
    if (!evaluation) { box.innerHTML = ""; return; }
    const [tone, label] = VERDICT[evaluation.verdict] || VERDICT.warn;
    box.innerHTML = `<div class="flow-note eval ${tone}"><b>${label}</b>　${esc(evaluation.summary)}${evaluation.findings.length ? `<ul>${evaluation.findings.map((f) => `<li class="${f.level}">${esc(f.message)}</li>`).join("")}</ul>` : ""}</div>`;
  }
  let evalTimer = 0;
  function scheduleEvaluation() {
    clearTimeout(evalTimer);
    evalTimer = setTimeout(async () => {
      const tasks = collectTasks();
      if (!tasks.length) { renderEvaluation(null); return; }
      try { renderEvaluation(await send("POST", "/api/split/evaluate", { tasks })); } catch { /* the evaluation is advice; the editor keeps working */ }
    }, 400);
  }
  function renderSplit(tasks, { evaluation = null } = {}) {
    const requirement = requirementOf(split.requirementId);
    const noModel = !engines.models.length;
    splitBody.innerHTML = `
      <div class="modal-head"><h2>拆分任务</h2><button class="close" data-close aria-label="关闭">×</button></div>
      <p class="flow-meta">${esc(requirement ? `${requirement.id} · ${requirement.title}` : split.requirementId)}<br><span class="dim">不是每条需求都要拆：一个任务就能交付和验收的，直接分配就好。AI 提议和手工拆分都要先评估，你确认后才会真正建立任务。</span></p>
      <div class="split-tools">
        <select data-s-engine ${noModel ? "disabled" : ""}>${engines.models.map((m) => `<option value="${esc(m.name)}">${esc(m.label)}（${esc(m.model)}）</option>`).join("") || "<option>未配置模型</option>"}</select>
        <button class="btn primary small" data-s-ai ${noModel ? "disabled" : ""}>AI 评估并拆分</button>
        <label class="dim" ${noModel ? "hidden" : ""}><input type="checkbox" data-s-project checked> 附带项目概况</label>
        <button class="btn small" data-s-add>＋ 手工添加一条</button>
        ${noModel ? '<span class="dim">没有配置模型 Key，不能让 AI 拆；可以手工拆，或到“设置”里填 Key。</span>' : ""}
      </div>
      ${split.note ? `<div class="flow-note ${split.note.tone}">${split.note.html}</div>` : ""}
      <div data-s-cards>${tasks.map(cardHtml).join("") || '<p class="dim" style="font-size:12px">还没有任务。点“AI 评估并拆分”，或“手工添加一条”。</p>'}</div>
      <div data-s-eval></div>
      <div class="flow-actions"><span class="grow dim">${split.draft ? `草稿 ${esc(split.draft.id)}` : ""}</span>
        <button class="btn danger" data-s-discard>放弃</button><button class="btn" data-close>先关闭</button><button class="btn primary" data-s-confirm>确认拆分，建立任务</button></div>`;
    renderEvaluation(evaluation);
    if (!evaluation && tasks.length) scheduleEvaluation();
  }
  async function openSplit(requirementId) {
    await loadEngines();
    split = { requirementId, draft: null, note: null };
    let tasks = [];
    try {
      const drafts = await request(`/api/requirements/${encodeURIComponent(requirementId)}/split-drafts`);
      const open = drafts.find((entry) => entry.status === "draft");
      if (open) {
        split.draft = open; tasks = open.tasks;
        split.note = { tone: "", html: `继续上次没处理完的${open.source === "provider" ? "AI 提议" : "手工"}草稿。` };
      }
    } catch { /* no drafts yet, or an older server */ }
    renderSplit(tasks);
    splitModal.classList.add("open");
  }
  let splitBusy = false;
  async function assessWithModel() {
    if (splitBusy) return;
    const engine = $("[data-s-engine]", splitBody).value;
    if ($$("[data-split-card]", splitBody).length && !(await WBDialog.confirm("AI 的提议会替换现在编辑区里的内容，继续吗？", { okText: "替换" }))) return;
    splitBusy = true;
    const button = $("[data-s-ai]", splitBody);
    button.disabled = true; button.textContent = "模型正在评估…（可能要半分钟）";
    try {
      const result = await send("POST", `/api/requirements/${encodeURIComponent(split.requirementId)}/split/assess`, { engine, includeProject: $("[data-s-project]", splitBody).checked });
      if (!result.needsSplit) {
        split.draft = null;
        split.note = { tone: "ok", html: `AI 判断这条需求<b>不需要拆分</b>：${esc(result.reason)}<br>可以直接“分配 AI”；如果你仍想拆，在下面手工添加。` };
        renderSplit([]);
        return;
      }
      split.draft = result.draft;
      split.note = { tone: "warn", html: `AI 认为<b>需要拆分</b>：${esc(result.reason)}<br>下面是它的提议，可以修改、删除或补充；确认后才会建立任务。` };
      renderSplit(result.draft.tasks, { evaluation: result.evaluation });
      if (result.projectOmitted) api.toast(`注意：${result.projectOmitted}`);
    } catch (error) {
      api.toast(`AI 评估失败：${error.message}`);
      button.disabled = false; button.textContent = "AI 评估并拆分";
    } finally { splitBusy = false; }
  }
  async function confirmSplit() {
    if (splitBusy) return;
    const tasks = collectTasks();
    if (!tasks.length) { api.toast("还没有任务可以确认"); return; }
    splitBusy = true;
    try {
      const evaluation = await send("POST", "/api/split/evaluate", { tasks });
      renderEvaluation(evaluation);
      if (evaluation.verdict === "bad") { api.toast("这个拆分还不能用，先看下面的提示"); return; }
      if (evaluation.verdict === "warn") {
        const count = evaluation.findings.filter((f) => f.level === "warn").length;
        if (!(await WBDialog.confirm(`评估有 ${count} 处提醒（见下方）。仍然按这个拆分建立任务吗？`, { okText: "仍然确认" }))) return;
      }
      let draft = split.draft;
      if (draft) draft = await send("PUT", `/api/split-drafts/${encodeURIComponent(draft.id)}`, { tasks, expectedRevision: draft.revision });
      else draft = await send("POST", `/api/requirements/${encodeURIComponent(split.requirementId)}/split-drafts`, { tasks });
      let result;
      try { result = await send("POST", `/api/split-drafts/${encodeURIComponent(draft.id)}/confirm`, { expectedRevision: draft.revision }); }
      catch (error) {
        if (error.code !== "STALE_DRAFT") throw error;
        if (!(await WBDialog.confirm("这条需求在草稿生成后被修改过。仍然按这个拆分建立任务吗？", { okText: "仍然确认" }))) return;
        result = await send("POST", `/api/split-drafts/${encodeURIComponent(draft.id)}/confirm`, { expectedRevision: draft.revision, acceptStale: true });
      }
      splitModal.classList.remove("open");
      split = null;
      await reload();
      api.toast(`已拆分，建立了 ${result.tasks.length} 个任务（待执行）`);
    } catch (error) { api.toast(`拆分失败：${error.message}`); }
    finally { splitBusy = false; }
  }
  async function discardSplit() {
    if (!(await WBDialog.confirm("放弃这次拆分？编辑区里的内容不会保留。", { okText: "放弃", danger: true }))) return;
    try { if (split?.draft) await send("POST", `/api/split-drafts/${encodeURIComponent(split.draft.id)}/discard`, { reason: "在页面放弃" }); }
    catch { /* already gone */ }
    splitModal.classList.remove("open");
    split = null;
  }
  splitModal.addEventListener("click", (event) => {
    if (event.target === splitModal || event.target.closest("[data-close]")) { splitModal.classList.remove("open"); return; }
    if (event.target.closest("[data-s-ai]")) { void assessWithModel(); return; }
    if (event.target.closest("[data-s-add]")) {
      const holder = $("[data-s-cards]", splitBody);
      if (!$("[data-split-card]", holder)) holder.innerHTML = "";
      holder.insertAdjacentHTML("beforeend", cardHtml({}));
      $$("[data-s-key]", holder).at(-1).focus();
      scheduleEvaluation();
      return;
    }
    const remove = event.target.closest("[data-s-remove]");
    if (remove) { remove.closest("[data-split-card]").remove(); scheduleEvaluation(); return; }
    if (event.target.closest("[data-s-confirm]")) { void confirmSplit(); return; }
    if (event.target.closest("[data-s-discard]")) { void discardSplit(); }
  });
  splitModal.addEventListener("input", (event) => { if (event.target.closest("[data-split-card]")) scheduleEvaluation(); });

  // The row's "拆分" button used to ask for a JSON array; it now opens this editor.
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-split-requirement]");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void openSplit(button.dataset.splitRequirement);
  }, true);

  // ---------- "AI 分析并细化" next to the result field of a collaboration task ----------
  function injectRefineButton() {
    const field = $("#task-result");
    if (!field || $("[data-ai-refine]")) return;
    const label = field.closest(".field")?.querySelector("label");
    if (!label) return;
    const row = document.createElement("div");
    row.className = "refine-row";
    label.replaceWith(row);
    row.append(label);
    const button = document.createElement("button");
    button.type = "button"; button.className = "btn small"; button.dataset.aiRefine = "true"; button.textContent = "AI 分析并细化";
    button.title = "让 AI 分析这条需求并把结果填到下面（有模型 Key 时可用）";
    row.append(button);
  }
  injectRefineButton();
  let refining = false;
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-ai-refine]");
    if (!button || refining) return;
    event.preventDefault();
    await loadEngines();
    if (!engines.models.length) {
      const toSettings = await WBDialog.confirm("还没有配置模型 Key，不能让 AI 直接分析。\n\n你可以：去“设置”填 DeepSeek / OpenAI / Claude 的 Key 和模型名；或者在需求行点“分配 AI → 分配并分析”，交给 Agent 分析。", { title: "需要模型 Key", okText: "去设置", cancelText: "知道了" });
      if (toSettings) { $("#task-modal")?.classList.remove("open"); $("#settings-nav")?.click(); }
      return;
    }
    const requirementId = ($("#task-feature-name")?.textContent || "").split(" · ")[0].trim();
    if (!requirementId) { api.toast("找不到这条任务对应的需求"); return; }
    const field = $("#task-result");
    if (field.value.trim() && !(await WBDialog.confirm("结果框里已经有内容，AI 的分析会替换它。继续吗？", { okText: "替换" }))) return;
    refining = true;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "AI 正在分析…";
    try {
      const result = await send("POST", `/api/requirements/${encodeURIComponent(requirementId)}/analysis/model`, { engine: engines.defaultEngine, record: false, includeProject: true });
      field.value = result.text;
      api.toast("已填入 AI 的分析，可以继续修改；保存后才会记录");
    } catch (error) { api.toast(`AI 分析失败：${error.message}`); }
    finally { refining = false; button.disabled = false; button.textContent = original; }
  });
})();
