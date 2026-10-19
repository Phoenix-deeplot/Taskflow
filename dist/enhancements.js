(() => {
  const api = window.WorkbenchAPI;
  if (!api) return;
  const $ = (selector) => document.querySelector(selector);
  const statuses = [
    ["clarification", "待澄清"],
    ["queued", "待执行"],
    ["working", "执行中"],
    ["review", "待验收"],
    ["done", "已完成"],
    ["blocked", "阻塞"],
  ];
  const nextStatuses = {
    clarification: ["queued", "blocked"],
    queued: ["working", "clarification", "blocked"],
    working: ["review", "queued", "blocked"],
    review: ["done", "queued", "blocked"],
    done: ["queued"],
    blocked: ["queued", "working", "clarification"],
  };
  let importDrafts = [];
  let importSource = "";

  const style = document.createElement("style");
  style.textContent = `
    .board-wrap{overflow:auto;padding:14px}.board{display:grid;grid-template-columns:repeat(6,minmax(210px,1fr));gap:11px;min-width:1320px;align-items:start}.board-col{background:#f5f7f8;border:1px solid #e8edef;border-radius:9px;min-height:260px;padding:9px}.board-col-head{display:flex;justify-content:space-between;align-items:center;padding:3px 4px 9px;color:#536773;font-size:11px;font-weight:650}.board-count{background:#e7edef;padding:2px 7px;border-radius:20px;color:#72828b;font-size:10px}.board-card{background:#fff;border:1px solid #e7ecee;border-radius:8px;padding:10px;margin-bottom:8px;box-shadow:0 2px 5px #1b38490a}.board-card-title{font-size:11px;font-weight:650;color:#304957;line-height:1.5}.board-card-sub{font-size:10px;color:#8a979e;margin-top:4px}.board-card-desc{font-size:10px;color:#667780;line-height:1.5;margin-top:7px;max-height:42px;overflow:hidden}.board-card select{margin-top:9px;width:100%;border:1px solid #e5eaed;border-radius:6px;background:#fff;color:#536773;padding:6px;font-size:10px}.board-empty{color:#9aa5ab;text-align:center;font-size:10px;padding:18px 4px}.import-area{width:100%;min-height:145px;border:1px solid #e3e9ec;border-radius:8px;padding:10px;font-size:12px;line-height:1.65;resize:vertical}.import-preview{max-height:240px;overflow:auto;border:1px solid #edf0f2;border-radius:8px;margin-top:10px}.import-preview-row{padding:9px 10px;border-bottom:1px solid #edf0f2;font-size:11px}.import-preview-row:last-child{border:0}.import-preview-row b{display:block;color:#344b58;margin-bottom:3px}.import-preview-row span{color:#829099}.import-hint{font-size:10px;color:#829099;line-height:1.55;margin:8px 0}.status-flow{font-size:10px;color:#809098;padding:10px 14px;border-bottom:1px solid #edf0f2;background:#fafcfc}.file-pick{font-size:11px;color:#637580}
    @media(max-width:650px){.board-wrap{padding:9px}.board{grid-template-columns:repeat(6,230px);min-width:0}.import-modal .modal{padding:15px}}
  `;
  document.head.append(style);
  const boardControlsStyle = document.createElement("style");
  boardControlsStyle.textContent = `.board-launch{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid #edf0f2;background:#fff;color:#536773;font-size:11px}.board-launch .btn:disabled{opacity:.5;cursor:not-allowed}.board-start{width:100%;margin-top:9px}`;
  document.head.append(boardControlsStyle);

  const importModal = document.createElement("div");
  importModal.className = "modal-bg import-modal";
  importModal.id = "text-import-modal";
  importModal.innerHTML = `<section class="modal">
    <div class="modal-head"><h2>导入需求草稿</h2><button class="close" id="import-close">×</button></div>
    <p class="import-hint">可粘贴 Prompt / 需求说明，或选择 JSON、TXT、Markdown、DOCX 文件。此处只做候选需求提取，不会自动调用 AI；确认预览后才会写入。</p>
    <div class="field"><textarea class="import-area" id="import-content" placeholder="粘贴需求或 Prompt。可用标题、编号列表或项目符号分隔功能点。若没有明确条目，会先作为一条需求草稿。"></textarea></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><label class="btn file-pick" for="import-file">选择文件</label><input hidden id="import-file" type="file" accept=".json,.txt,.md,.markdown,.docx,application/json,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"><button class="btn" id="parse-import">解析并预览</button><span class="file-pick" id="import-filename"></span></div>
    <div class="import-preview" id="import-preview" hidden></div>
    <div class="modal-foot"><span id="import-count">未解析</span><button class="btn primary" id="confirm-import" disabled>确认导入</button></div>
  </section>`;
  document.body.append(importModal);

  function safe(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function getState() { return api.state; }

  function renderBoard() {
    const state = getState();
    const panel = api.getDynamicPanel();
    if (!panel) return;
    const nextTask = state.tasks
      .filter((task) => (task.status || "queued") === "queued")
      .sort((a, b) => String(a.createdAt || a.updatedAt).localeCompare(String(b.createdAt || b.updatedAt)))[0];
    panel.innerHTML = `<div class="status-flow">流转规则：待澄清 → 待执行 → 执行中 → 待验收 → 已完成；信息不足退回待澄清，风险/依赖受阻进入阻塞。完成状态需人工确认。当前原型的“启动”会更新状态并复制任务指令；尚未连接外部 Agent。</div><div class="board-launch"><span>${nextTask ? `下一项：${safe(nextTask.featureTitle || state.items.find((item) => item.id === nextTask.featureId)?.title || nextTask.id)}` : "当前没有待执行任务"}</span><button class="btn primary" data-start-next ${nextTask ? "" : "disabled"}>▶ 启动下一项待执行任务</button></div><div class="board-wrap"><div class="board">${statuses.map(([key, label]) => {
      const tasks = state.tasks.filter((task) => (task.status || "queued") === key);
      return `<section class="board-col"><div class="board-col-head"><span>${label}</span><span class="board-count">${tasks.length}</span></div>${tasks.length ? tasks.map((task) => {
        const feature = state.items.find((item) => item.id === task.featureId);
        const launch = key === "queued" ? `<button class="btn primary small board-start" data-start-task="${safe(task.id)}">▶ 启动任务</button>` : "";
        return `<article class="board-card"><div class="board-card-title">${safe(feature?.title || task.featureTitle || "未关联需求")}</div><div class="board-card-sub">${safe(task.id)} · ${safe(task.assignee || "未分配负责人")} · ${safe(({chatgpt:"ChatGPT",deepseek:"DeepSeek",claude:"Claude"})[task.model] || task.model || "Agent")}</div><div class="board-card-desc">${safe(task.task || "暂无任务说明")}</div>${task.blockedReason ? `<div class="board-card-sub" style="color:#a45c57">阻塞：${safe(task.blockedReason)}</div>` : ""}${launch}<select data-transition="${safe(task.id)}" aria-label="更新任务状态"><option value="${key}">${label}</option>${(nextStatuses[key] || []).map((next) => `<option value="${next}">转为${statuses.find((s) => s[0] === next)?.[1]}</option>`).join("")}</select></article>`;
      }).join("") : `<div class="board-empty">暂无任务</div>`}</section>`;
    }).join("")}</div></div>`;
    panel.querySelectorAll("[data-transition]").forEach((select) => {
      select.addEventListener("change", () => transitionTask(select.dataset.transition, select.value));
    });
    panel.querySelector("[data-start-next]")?.addEventListener("click", () => nextTask && startTask(nextTask.id));
    panel.querySelectorAll("[data-start-task]").forEach((button) => {
      button.addEventListener("click", () => startTask(button.dataset.startTask));
    });
  }

  function createContextSnapshot(task) {
    const state = getState();
    const feature = state.items.find((item) => item.id === task.featureId);
    return {
      id: `CTX-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      workspace: {
        updatedAt: state.updatedAt,
        requirementCount: state.items.length,
        requirements: state.items.map((item) => ({ id: item.id, module: item.module, title: item.title, targetVersion: item.targetVersion, decision: item.decision })),
      },
      requirement: feature ? { id: feature.id, module: feature.module, title: feature.title, description: feature.description, targetVersion: feature.targetVersion, decision: feature.decision, decisionNote: feature.decisionNote } : { id: task.featureId, title: task.featureTitle, module: task.featureModule },
      task: { id: task.id, model: task.model, assignee: task.assignee, task: task.task, acceptanceCriteria: task.acceptanceCriteria || "" },
    };
  }

  function buildTaskPrompt(task, snapshot = task.contextSnapshot || createContextSnapshot(task)) {
    const requirement = snapshot.requirement || {};
    const taskContext = snapshot.task || task;
    return `你是本任务的执行 Agent。只处理本任务范围；遇到缺失信息、冲突或超出范围的改动先说明，不要擅自扩大。

任务上下文快照：${snapshot.id}（v${snapshot.schemaVersion}，${snapshot.createdAt}）
全局需求摘要：${snapshot.workspace?.requirementCount || 0} 条需求；工作区更新时间 ${snapshot.workspace?.updatedAt || "未知"}
相关需求：${requirement.title || "未关联需求"}（${requirement.id || "无 ID"}）
模块：${requirement.module || "未分类"}
目标版本：${requirement.targetVersion || "未指定"}
需求说明：${requirement.description || "暂无"}
当前决策：${requirement.decision || "待讨论"}；决策说明：${requirement.decisionNote || "无"}
执行人：${taskContext.assignee || taskContext.model || "未分配"}

本任务：
${taskContext.task || "请先分析需求并提出可执行步骤。"}

全局需求索引快照（仅 ID / 模块 / 标题 / 版本 / 决策摘要，用于降低上下文长度；只读）：
${JSON.stringify(snapshot.workspace?.requirements || [], null, 2)}

完成时请返回：实际完成内容、涉及文件/产物、执行过的检查及结果、未解决问题。若任务说明包含验收标准，逐条给出证据。不要直接修改全局需求决策。`;
  }

  async function startTask(taskId) {
    const task = getState().tasks.find((item) => item.id === taskId);
    if (!task || (task.status || "queued") !== "queued") return;
    transitionTask(taskId, "working");
    const startedTask = getState().tasks.find((item) => item.id === taskId);
    const promptText = buildTaskPrompt(startedTask, startedTask?.contextSnapshot);
    try {
      await navigator.clipboard.writeText(promptText);
      api.toast("任务已启动；指令已复制，请交给卡片上标记的 Agent 执行");
    } catch {
      window.prompt("任务已启动。复制以下指令并交给对应 Agent：", promptText);
    }
  }
  window.startWorkbenchTask = startTask;

  function transitionTask(taskId, target) {
    const state = getState();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const current = task.status || "queued";
    if (!(nextStatuses[current] || []).includes(target)) {
      api.toast("不允许此状态流转");
      api.render();
      return;
    }
    if (target === "done" && !confirm("确认该任务成果已由负责人验收通过？")) {
      api.render();
      return;
    }
    let blockedReason = task.blockedReason || "";
    if (target === "blocked") {
      blockedReason = prompt("请填写阻塞原因（必填）", blockedReason)?.trim() || "";
      if (!blockedReason) {
        api.toast("阻塞任务必须填写原因");
        api.render();
        return;
      }
    }
    const before = JSON.parse(JSON.stringify(task));
    task.runs = Array.isArray(task.runs) ? task.runs : [];
    if (target === "working" && !task.runs.some((run) => run.status === "running")) {
      task.contextSnapshot = createContextSnapshot(task);
      task.runs.push({ id: `RUN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, contextSnapshotId: task.contextSnapshot.id, status: "running", startedAt: new Date().toISOString(), finishedAt: null });
    }
    task.status = target;
    task.blockedReason = target === "blocked" ? blockedReason : "";
    task.updatedAt = new Date().toISOString();
    const activeRun = task.runs.slice().reverse().find((run) => run.status === "running");
    if (activeRun && ["review", "done", "blocked"].includes(target)) {
      activeRun.status = target === "review" ? "awaiting_review" : target;
      activeRun.finishedAt = task.updatedAt;
    }
    if (target === "done") {
      const reviewRun = task.runs.slice().reverse().find((run) => run.status === "awaiting_review");
      if (reviewRun) { reviewRun.status = "accepted"; reviewRun.finishedAt = task.updatedAt; }
    }
    api.addEvent(`任务状态：${statuses.find((s) => s[0] === current)?.[1]} → ${statuses.find((s) => s[0] === target)?.[1]}`, "ai_task", task.id, before, { ...task });
    api.save();
    api.toast("状态已更新并记录变更");
  }

  function setView(view) {
    document.querySelectorAll(".nav[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    $("#crumb-title").textContent = "执行看板";
    $("#page-title").textContent = "执行看板";
    $("#page-subtitle").textContent = "查看任务状态、负责人和阻塞项；流转有规则，成果由你验收。";
    const headActions = $("#head-actions");
    if (headActions) headActions.style.display = "none";
    $("#tabs").style.display = "none";
    const toolbar = $("#toolbar");
    if (toolbar) toolbar.hidden = true;
    renderBoard();
  }

  window.renderTaskBoard = renderBoard;
  window.taskStatusTransitions = nextStatuses;

  document.addEventListener("click", (event) => {
    if (event.target.closest("#import-nav")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      $("#text-import-modal").classList.add("open");
    }
  }, true);

  document.addEventListener("change", (event) => {
    const select = event.target.closest("[data-status]");
    if (!select) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    transitionTask(select.dataset.status, select.value);
  }, true);

  const modalStatusObserver = new MutationObserver(() => {
    const select = $("#task-status");
    const modal = $("#task-modal");
    if (!modal.classList.contains("open")) return;
    const editId = $("#save-task").dataset.editId;
    const task = editId ? getState().tasks.find((item) => item.id === editId) : null;
    if (task) {
      const label = statuses.find((status) => status[0] === (task.status || "queued"))?.[1] || "待执行";
      select.innerHTML = `<option value="${safe(task.status || "queued")}">${label}（请到看板流转）</option>`;
      select.value = task.status || "queued";
      select.disabled = true;
    } else {
      select.innerHTML = '<option value="clarification">待澄清</option><option value="queued">待执行</option>';
      select.disabled = false;
      select.value = "queued";
    }
  });
  modalStatusObserver.observe($("#task-modal"), { attributes: true, attributeFilter: ["class"] });

  function newId(prefix) { return `${prefix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`; }

  function parsePlainText(text) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const candidates = [];
    let module = "导入草稿";
    let current = null;
    for (const line of lines) {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      const itemLine = line.match(/^(?:[-*•]\s+|\d{1,3}[.、)]\s+)(.+)$/);
      if (heading && heading[1].length < 34 && !/[。！？]$/.test(heading[1])) {
        if (current) candidates.push(current);
        module = heading[1].replace(/\s*#+$/, "").trim() || "导入草稿";
        current = null;
      } else if (itemLine || heading) {
        if (current) candidates.push(current);
        current = { module, title: (itemLine?.[1] || heading?.[1] || line).slice(0, 140), description: "" };
      } else if (current) {
        current.description += (current.description ? "\n" : "") + line;
      }
    }
    if (current) candidates.push(current);
    if (!candidates.length && text.trim()) {
      const normalized = text.trim().replace(/\s+/g, " ");
      const sentence = normalized.match(/^(.{1,100}?[。！？.!?])(?:\s|$)/)?.[1];
      candidates.push({ module: "导入草稿", title: (sentence || normalized.slice(0, 80)).replace(/[。！？.!?]$/, ""), description: text.trim() });
    }
    return candidates;
  }

  function rowsFromJson(json) {
    const rows = Array.isArray(json) ? json : (json.items || json.features || json.requirements);
    if (!Array.isArray(rows)) throw new Error("JSON 中找不到 items / features / requirements 数组");
    return rows.map((row) => ({
      id: typeof row.id === "string" ? row.id : "",
      module: typeof row.module === "string" ? row.module : "导入草稿",
      title: String(row.title || row.name || row.requirement || "").trim(),
      description: typeof row.description === "string" ? row.description : typeof row.acceptance === "string" ? row.acceptance : "",
      targetVersion: ["V1", "V2", "V3", "Later"].includes(row.targetVersion) ? row.targetVersion : "V1",
      decision: ["pending", "keep", "modify", "defer", "delete"].includes(row.decision) ? row.decision : "pending",
      decisionNote: typeof row.decisionNote === "string" ? row.decisionNote : "",
    })).filter((row) => row.title);
  }

  async function extractDocx(file) {
    if (typeof DecompressionStream !== "function") throw new Error("此浏览器不支持本地 DOCX 解压；请另存为 TXT/Markdown，或复制正文粘贴。");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("无法识别 DOCX 文件（不是有效的 ZIP 文档）");
    const entries = view.getUint16(eocd + 10, true);
    let cursor = view.getUint32(eocd + 16, true);
    let xmlBytes = null;
    for (let entry = 0; entry < entries; entry++) {
      if (view.getUint32(cursor, true) !== 0x02014b50) break;
      const method = view.getUint16(cursor + 10, true);
      const size = view.getUint32(cursor + 20, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const name = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
      if (name === "word/document.xml") {
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = bytes.slice(start, start + size);
        if (method === 0) xmlBytes = compressed;
        else if (method === 8) {
          const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
          xmlBytes = new Uint8Array(await new Response(stream).arrayBuffer());
        } else throw new Error("该 DOCX 使用了暂不支持的压缩格式");
        break;
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (!xmlBytes) throw new Error("DOCX 中找不到正文内容");
    const xml = new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes), "application/xml");
    const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    return [...xml.getElementsByTagNameNS(ns, "p")].map((paragraph) => [...paragraph.getElementsByTagNameNS(ns, "t")].map((node) => node.textContent).join("")).filter(Boolean).join("\n");
  }

  async function parseImport() {
    try {
      const file = $("#import-file").files[0];
      let text = $("#import-content").value.trim();
      importSource = file?.name || "粘贴内容";
      if (file) {
        if (file.name.toLowerCase().endsWith(".docx")) text = await extractDocx(file);
        else text = await file.text();
        if (file.name.toLowerCase().endsWith(".json")) {
          try { importDrafts = rowsFromJson(JSON.parse(text)); }
          catch (error) { throw new Error(error.message || "JSON 格式无效"); }
        } else importDrafts = parsePlainText(text);
      } else if (!text) {
        throw new Error("请先粘贴内容或选择文件");
      } else {
        try {
          importDrafts = rowsFromJson(JSON.parse(text));
          importSource = "粘贴的 JSON";
        } catch {
          importDrafts = parsePlainText(text);
        }
      }
      if (!importDrafts.length) throw new Error("没有解析出候选需求；请用编号或项目符号列出功能点");
      const preview = $("#import-preview");
      preview.hidden = false;
      preview.innerHTML = importDrafts.map((item, index) => `<div class="import-preview-row"><b>${index + 1}. ${safe(item.title)}</b><span>${safe(item.module)} · ${safe(item.description || "暂无说明")}</span></div>`).join("");
      $("#import-count").textContent = `从 ${importSource} 解析出 ${importDrafts.length} 条草稿；确认后追加，不覆盖现有需求。`;
      $("#confirm-import").disabled = false;
    } catch (error) {
      $("#import-count").textContent = error.message || "解析失败";
      $("#confirm-import").disabled = true;
      $("#import-preview").hidden = true;
    }
  }

  function confirmImport() {
    const state = getState();
    const existingIds = new Set(state.items.map((item) => item.id));
    const now = new Date().toISOString();
    let added = 0;
    for (const draft of importDrafts) {
      if (draft.id && existingIds.has(draft.id)) continue;
      const item = {
        id: draft.id || newId("REQ"), module: draft.module || "导入草稿", title: draft.title,
        description: draft.description || "", sourceVersion: "导入", targetVersion: draft.targetVersion || "V1",
        decision: draft.decision || "pending", decisionNote: draft.decisionNote || "", createdAt: now, updatedAt: now,
      };
      state.items.push(item);
      existingIds.add(item.id);
      api.addEvent("导入需求草稿", "feature", item.id, null, item);
      added++;
    }
    api.save();
    $("#text-import-modal").classList.remove("open");
    $("#import-content").value = "";
    $("#import-file").value = "";
    $("#import-preview").hidden = true;
    $("#confirm-import").disabled = true;
    $("#import-count").textContent = "未解析";
    importDrafts = [];
    api.toast(added ? `已导入 ${added} 条需求草稿` : "没有新记录（重复 ID 已跳过）");
  }

  $("#import-close").onclick = () => $("#text-import-modal").classList.remove("open");
  $("#parse-import").onclick = parseImport;
  $("#confirm-import").onclick = confirmImport;
  $("#import-file").onchange = () => {
    const file = $("#import-file").files[0];
    $("#import-filename").textContent = file?.name || "";
  };
  $("#text-import-modal").addEventListener("click", (event) => {
    if (event.target.id === "text-import-modal") event.currentTarget.classList.remove("open");
  });
})();
