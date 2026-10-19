"use client";

import { ArrowDownToLine, ArrowUpFromLine, Bot, Check, ClipboardList, Clock3, Copy, FilePlus2, Filter, History, Layers3, LoaderCircle, Plus, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Decision = "pending" | "keep" | "modify" | "defer" | "delete";
type Status = "queued" | "working" | "review" | "done";
type Feature = { id: string; module: string; title: string; description: string; sourceVersion: string; targetVersion: string; decision: Decision; decisionNote: string; createdAt: string; updatedAt: string; latestTask?: Task | null };
type Task = { id: string; featureId: string; model: string; task: string; status: Status; suggestion: string; createdAt: string; updatedAt: string; featureTitle?: string | null; featureModule?: string | null };
type EventRow = { id: number; entityType: string; entityId: string; action: string; actorId: string; beforeJson: string | null; afterJson: string | null; createdAt: string };
type View = "requirements" | "ai" | "history";
type Draft = Pick<Feature, "module" | "title" | "description" | "targetVersion" | "decision" | "decisionNote">;

const decisions: { value: Decision; label: string; tone: string }[] = [
  { value: "pending", label: "待讨论", tone: "bg-slate-100 text-slate-600" },
  { value: "keep", label: "保留", tone: "bg-emerald-50 text-emerald-700" },
  { value: "modify", label: "修改后保留", tone: "bg-blue-50 text-blue-700" },
  { value: "defer", label: "延后", tone: "bg-amber-50 text-amber-700" },
  { value: "delete", label: "删除", tone: "bg-rose-50 text-rose-700" },
];
const versions = ["V1", "V2", "V3", "Later"];
const modelLabels: Record<string, string> = { deepseek: "DeepSeek", chatgpt: "ChatGPT", claude: "Claude" };
const statusLabels: Record<Status, string> = { queued: "待开始", working: "进行中", review: "待你确认", done: "已完成" };
const emptyDraft: Draft = { module: "工具模块", title: "", description: "", targetVersion: "V1", decision: "pending", decisionNote: "" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败 (" + response.status + ")");
  return data as T;
}
function decisionMeta(value: Decision) { return decisions.find((item) => item.value === value) || decisions[0]; }
function timeLabel(value: string) {
  if (!value) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export default function Workbench({ user }: { user: { name: string; email: string } }) {
  const [view, setView] = useState<View>("requirements");
  const [items, setItems] = useState<Feature[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [versionFilter, setVersionFilter] = useState("全部版本");
  const [decisionFilter, setDecisionFilter] = useState("全部状态");
  const [moduleFilter, setModuleFilter] = useState("全部模块");
  const [selected, setSelected] = useState<string[]>([]);
  const [panelItem, setPanelItem] = useState<Feature | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [taskModel, setTaskModel] = useState("chatgpt");
  const [taskText, setTaskText] = useState("");
  const [editingTask, setEditingTask] = useState<string | null>(null);
  const [suggestionDraft, setSuggestionDraft] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const values = await Promise.all([
        api<{ items: Feature[] }>("/api/features"),
        api<{ tasks: Task[] }>("/api/ai-tasks"),
        api<{ events: EventRow[] }>("/api/events"),
      ]);
      setItems(values[0].items); setTasks(values[1].tasks); setEvents(values[2].events);
    } catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 2800); return () => window.clearTimeout(timer); }, [notice]);

  const modules = useMemo(() => Array.from(new Set(items.map((item) => item.module))).sort(), [items]);
  const visibleItems = useMemo(() => items.filter((item) => {
    const haystack = (item.id + " " + item.title + " " + item.description + " " + item.module).toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) &&
      (versionFilter === "全部版本" || item.targetVersion === versionFilter) &&
      (decisionFilter === "全部状态" || item.decision === decisionFilter) &&
      (moduleFilter === "全部模块" || item.module === moduleFilter);
  }), [items, query, versionFilter, decisionFilter, moduleFilter]);
  const keptCount = items.filter((item) => item.decision === "keep" || item.decision === "modify").length;
  const deferredCount = items.filter((item) => item.decision === "defer").length;
  const pendingCount = items.filter((item) => item.decision === "pending").length;
  const activeTaskCount = tasks.filter((task) => task.status !== "done").length;

  function openNew() { setPanelItem(null); setDraft(emptyDraft); setPanelOpen(true); setTaskText(""); }
  function openEdit(item: Feature) {
    setPanelItem(item);
    setDraft({ module: item.module, title: item.title, description: item.description, targetVersion: item.targetVersion, decision: item.decision, decisionNote: item.decisionNote });
    setPanelOpen(true); setTaskText("");
  }
  async function saveFeature(event: React.FormEvent) {
    event.preventDefault(); if (!draft.title.trim()) return;
    setBusy(true);
    try {
      if (panelItem) {
        await api("/api/features/" + encodeURIComponent(panelItem.id), { method: "PATCH", body: JSON.stringify(draft) });
        setNotice("已保存修改");
      } else {
        await api("/api/features", { method: "POST", body: JSON.stringify(draft) });
        setNotice("已新增需求");
      }
      setPanelOpen(false); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  }
  async function quickDecision(item: Feature, decision: Decision) {
    try {
      await api("/api/features/" + encodeURIComponent(item.id), { method: "PATCH", body: JSON.stringify({ decision }) });
      setItems((current) => current.map((row) => row.id === item.id ? { ...row, decision } : row));
      setNotice("决策已保存");
    } catch (e) { setError(e instanceof Error ? e.message : "更新失败"); }
  }
  async function bulkDecision(decision: Decision) {
    if (!selected.length) return;
    setBusy(true);
    try {
      await Promise.all(selected.map((id) => api("/api/features/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ decision }) })));
      const n = selected.length; setSelected([]); setNotice("已更新 " + n + " 项"); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "批量更新失败"); }
    finally { setBusy(false); }
  }
  async function createTask(event: React.FormEvent) {
    event.preventDefault(); if (!panelItem || !taskText.trim()) return;
    setBusy(true);
    try {
      await api("/api/ai-tasks", { method: "POST", body: JSON.stringify({ featureId: panelItem.id, model: taskModel, task: taskText }) });
      setTaskText(""); setNotice("AI 任务已加入工作队列"); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "创建任务失败"); }
    finally { setBusy(false); }
  }
  async function updateTask(task: Task, patch: Partial<Task>) {
    try {
      await api("/api/ai-tasks/" + encodeURIComponent(task.id), { method: "PATCH", body: JSON.stringify(patch) });
      setNotice("AI 任务已更新"); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "任务更新失败"); }
  }
  async function seedStarter() {
    setBusy(true);
    try { const result = await api<{ count: number }>("/api/seed", { method: "POST" }); setNotice("已载入 " + result.count + " 项工具模块草案"); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "载入失败"); }
    finally { setBusy(false); }
  }
  async function exportJson() {
    try {
      const response = await fetch("/api/backup"); if (!response.ok) throw new Error("导出失败");
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = "requirements-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      link.click(); URL.revokeObjectURL(url); setNotice("JSON 备份已下载");
    } catch (e) { setError(e instanceof Error ? e.message : "导出失败"); }
  }
  async function importJson(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text()) as { items?: unknown[] };
      const result = await api<{ imported: number }>("/api/import", { method: "POST", body: JSON.stringify({ items: parsed.items }) });
      setNotice("已导入 " + result.imported + " 项；同编号记录已合并更新"); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "导入失败"); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }
  async function copyTaskPrompt(item: Feature) {
    const prompt = [
      "请只评估以下需求，不要重写整份文档。",
      "编号：" + item.id, "模块：" + item.module, "功能：" + item.title,
      "说明：" + item.description, "当前处理：" + decisionMeta(item.decision).label,
      "目标版本：" + item.targetVersion,
      "请返回：1.建议（保留/修改/延后/删除）2.修改后的功能描述（如有）3.理由与依据 4.需要我确认的问题。",
    ].join("\n");
    try { await navigator.clipboard.writeText(prompt); setNotice("任务上下文已复制"); }
    catch { setError("复制失败，请手动复制任务说明"); }
  }

  const nav = [
    { id: "requirements" as const, label: "需求清单", icon: ClipboardList, count: items.length },
    { id: "ai" as const, label: "AI 任务", icon: Bot, count: activeTaskCount },
    { id: "history" as const, label: "修改记录", icon: History, count: events.length },
  ];
  const title = nav.find((item) => item.id === view)?.label || "需求清单";

  return <div className="min-h-screen bg-[#f5f7f9] text-[#182433]">
    <header className="sticky top-0 z-20 flex h-[68px] items-center justify-between border-b border-[#e5e9ee] bg-white/95 px-5 backdrop-blur md:px-8">
      <div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[#17334c] text-white"><Layers3 size={18} /></div><div><div className="text-[13px] font-bold tracking-[.02em]">CHUHAI LAB</div><div className="text-[11px] text-slate-500">产品需求工作台</div></div></div>
      <div className="flex items-center gap-3"><div className="hidden items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 sm:flex"><span className="h-2 w-2 rounded-full bg-emerald-500" />已连接云端数据</div><div className="grid h-8 w-8 place-items-center rounded-full bg-[#e4edf4] text-xs font-bold text-[#254e6c]" title={user.email}>{user.name.slice(0, 1).toUpperCase()}</div></div>
    </header>
    <div className="mx-auto flex max-w-[1600px]">
      <aside className="sticky top-[68px] hidden h-[calc(100vh-68px)] w-[228px] shrink-0 flex-col border-r border-[#e5e9ee] bg-white px-4 py-6 md:flex">
        <div className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[.14em] text-slate-400">工作区</div>
        <div className="mb-2 flex items-center gap-3 rounded-xl bg-[#edf3f7] px-3 py-3"><div className="grid h-8 w-8 place-items-center rounded-lg bg-white text-[#356f9e]"><Layers3 size={16} /></div><div className="min-w-0"><div className="truncate text-xs font-semibold">出海产品 V1</div><div className="mt-0.5 text-[10px] text-slate-500">需求评估空间</div></div></div>
        <div className="mt-5 space-y-1">{nav.map((item) => { const Icon = item.icon; const active = view === item.id; return <button key={item.id} onClick={() => setView(item.id)} className={"flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] transition " + (active ? "bg-[#17334c] font-semibold text-white shadow-sm" : "text-slate-600 hover:bg-slate-100")}><Icon size={16} /><span className="flex-1">{item.label}</span>{item.id !== "history" && <span className={active ? "text-[10px] text-white/70" : "text-[10px] text-slate-400"}>{item.count}</span>}</button>; })}</div>
        <div className="mt-auto rounded-xl border border-[#e5e9ee] bg-[#fbfcfd] p-3.5"><div className="flex items-center gap-2 text-xs font-semibold text-slate-700"><Sparkles size={14} className="text-[#bf8a45]" />AI 协作方式</div><p className="mt-2 text-[11px] leading-5 text-slate-500">按单项需求创建任务，复制精简上下文给 AI，结果回填后由你确认。</p></div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-9 lg:py-8">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div><div className="mb-2 flex items-center gap-2 text-[11px] text-slate-500"><span>产品管理</span><span>/</span><span className="text-[#356f9e]">{title}</span></div><h1 className="text-[25px] font-semibold tracking-[-.03em] text-[#182433]">{title}</h1><p className="mt-1.5 max-w-2xl text-[13px] text-slate-500">{view === "requirements" ? "逐项评估工具模块需求，决策、意见和版本归属都保存在同一份台账中。" : view === "ai" ? "把单项需求交给不同模型分析，集中查看任务状态和建议。" : "每次新增、修改和导入都会留下记录，便于回看决策变化。"}</p></div>
          <div className="flex flex-wrap items-center gap-2"><input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importJson(event.target.files?.[0])} /><button onClick={() => fileInput.current?.click()} className="focus-ring inline-flex items-center gap-2 rounded-lg border border-[#dce2e8] bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"><ArrowUpFromLine size={14} />导入 JSON</button><button onClick={() => void exportJson()} className="focus-ring inline-flex items-center gap-2 rounded-lg border border-[#dce2e8] bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"><ArrowDownToLine size={14} />导出备份</button>{view === "requirements" && <button onClick={openNew} className="focus-ring inline-flex items-center gap-2 rounded-lg bg-[#17334c] px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-[#244967]"><Plus size={15} />新增需求</button>}</div>
        </div>
        {error && <div role="alert" className="mb-5 flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700"><span>{error}</span><button onClick={() => setError("")} aria-label="关闭错误提示"><X size={14} /></button></div>}
        {notice && <div role="status" className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-lg bg-[#193d58] px-4 py-3 text-xs font-medium text-white shadow-lg"><Check size={15} />{notice}</div>}
        {view === "requirements" && <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="需求总数" value={items.length} detail="当前台账中的功能项" icon={<ClipboardList size={17} />} tone="blue" /><Metric label="保留范围" value={keptCount} detail="保留或修改后保留" icon={<Check size={17} />} tone="green" /><Metric label="延后评估" value={deferredCount} detail="可筛选进入后续版本" icon={<Clock3 size={17} />} tone="amber" /><Metric label="待讨论" value={pendingCount} detail={activeTaskCount + " 个 AI 任务未完成"} icon={<Bot size={17} />} tone="slate" /></div>
          <section className="overflow-hidden rounded-2xl border border-[#e3e8ed] bg-white shadow-[0_2px_12px_rgb(27_46_62/3%)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e9edf1] px-4 py-4 sm:px-5"><div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-[#e2e7ec] bg-[#fbfcfd] px-3 py-2 sm:max-w-[330px]"><Search size={15} className="text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号、功能或说明" className="w-full bg-transparent text-xs outline-none placeholder:text-slate-400" /></div><div className="flex flex-wrap items-center gap-2"><Filter size={14} className="mr-0.5 text-slate-400" /><Select value={versionFilter} onChange={setVersionFilter} options={["全部版本", ...versions]} /><Select value={decisionFilter} onChange={setDecisionFilter} options={["全部状态", ...decisions.map((item) => item.value)]} labels={Object.fromEntries(decisions.map((item) => [item.value, item.label]))} /><Select value={moduleFilter} onChange={setModuleFilter} options={["全部模块", ...modules]} /></div></div>
            {selected.length > 0 && <div className="flex flex-wrap items-center gap-2 border-b border-[#e9edf1] bg-[#f6f9fb] px-5 py-2.5 text-xs"><span className="mr-2 text-slate-600">已选 {selected.length} 项</span>{decisions.filter((item) => item.value !== "pending").map((item) => <button key={item.value} onClick={() => void bulkDecision(item.value)} className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-slate-600 hover:border-slate-300">设为{item.label}</button>)}<button onClick={() => setSelected([])} className="ml-auto text-slate-500 hover:text-slate-800">取消选择</button></div>}
            {loading ? <LoadingState /> : items.length === 0 ? <EmptyState onSeed={seedStarter} onCreate={openNew} busy={busy} /> : visibleItems.length === 0 ? <div className="px-6 py-16 text-center text-sm text-slate-500">没有符合筛选条件的需求。</div> : <div className="overflow-x-auto"><table className="w-full min-w-[940px] border-collapse text-left">
              <thead><tr className="bg-[#fafbfd] text-[10px] font-semibold uppercase tracking-[.08em] text-slate-500"><th className="w-10 px-5 py-3"><input aria-label="全选当前筛选结果" type="checkbox" checked={visibleItems.length > 0 && visibleItems.every((item) => selected.includes(item.id))} onChange={(event) => setSelected(event.target.checked ? visibleItems.map((item) => item.id) : [])} /></th><th className="px-2 py-3">功能需求</th><th className="px-3 py-3">模块</th><th className="px-3 py-3">目标版本</th><th className="px-3 py-3">处理决策</th><th className="px-3 py-3">AI 协作</th><th className="px-5 py-3 text-right">最近更新</th></tr></thead>
              <tbody>{visibleItems.map((item) => <tr key={item.id} className="group border-t border-[#edf0f3] transition hover:bg-[#fbfcfd]">
                <td className="px-5 py-4 align-top"><input aria-label={"选择 " + item.id} type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /></td>
                <td className="max-w-[400px] px-2 py-3.5 align-top"><button onClick={() => openEdit(item)} className="text-left"><span className="mb-1 block font-mono text-[10px] text-slate-400">{item.id}</span><span className="block text-[13px] font-semibold text-[#20374c] group-hover:text-[#356f9e]">{item.title}</span><span className="mt-1 line-clamp-2 block text-[11px] leading-5 text-slate-500">{item.description || "暂无说明"}</span></button></td>
                <td className="px-3 py-4 align-top"><span className="rounded-md bg-[#f0f3f6] px-2 py-1 text-[10px] text-slate-600">{item.module}</span></td><td className="px-3 py-4 align-top"><span className="rounded-md border border-[#e4e9ee] px-2 py-1 text-[10px] font-semibold text-slate-600">{item.targetVersion}</span></td>
                <td className="px-3 py-3 align-top"><select aria-label={"设置 " + item.id + " 决策"} value={item.decision} onChange={(event) => void quickDecision(item, event.target.value as Decision)} className={"focus-ring rounded-md border-0 px-2 py-1.5 text-[10px] font-semibold outline-none " + decisionMeta(item.decision).tone}>{decisions.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></td>
                <td className="px-3 py-4 align-top">{item.latestTask ? <button onClick={() => { setView("ai"); setEditingTask(item.latestTask!.id); }} className="flex items-center gap-1.5 text-[10px] text-slate-600 hover:text-[#356f9e]"><span className="grid h-6 w-6 place-items-center rounded-full bg-[#eef4f8] text-[#356f9e]"><Bot size={13} /></span>{modelLabels[item.latestTask.model] || item.latestTask.model}<span className="text-slate-400">· {statusLabels[item.latestTask.status]}</span></button> : <span className="text-[10px] text-slate-400">未分配</span>}</td>
                <td className="px-5 py-4 text-right align-top text-[10px] text-slate-400">{timeLabel(item.updatedAt)}</td>
              </tr>)}</tbody>
            </table></div>}
            <div className="flex items-center justify-between border-t border-[#e9edf1] bg-[#fbfcfd] px-5 py-3 text-[10px] text-slate-500"><span>显示 {visibleItems.length} / {items.length} 项</span><span>状态与修改会自动保存到云端</span></div>
          </section>
        </>}
        {view === "ai" && <section className="overflow-hidden rounded-2xl border border-[#e3e8ed] bg-white shadow-[0_2px_12px_rgb(27_46_62/3%)]"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e9edf1] px-5 py-4"><div><h2 className="text-sm font-semibold">AI 协作队列</h2><p className="mt-1 text-[11px] text-slate-500">任务通过复制上下文、人工提交给模型后回填结果。</p></div><span className="rounded-full bg-[#eef4f8] px-2.5 py-1 text-[10px] font-medium text-[#356f9e]">{tasks.length} 项</span></div>
          {loading ? <LoadingState /> : tasks.length === 0 ? <div className="px-6 py-16 text-center"><div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#eef4f8] text-[#356f9e]"><Bot size={22} /></div><h3 className="mt-4 text-sm font-semibold">还没有 AI 任务</h3><p className="mt-1 text-xs text-slate-500">从需求详情创建一项任务，并记录负责模型。</p><button onClick={() => setView("requirements")} className="mt-4 rounded-lg bg-[#17334c] px-3.5 py-2 text-xs font-semibold text-white">打开需求清单</button></div> :
          <div className="divide-y divide-[#edf0f3]">{tasks.map((task) => <article key={task.id} className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_190px]">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[#eef4f8] px-2 py-1 text-[10px] font-semibold text-[#356f9e]">{modelLabels[task.model] || task.model}</span><span className="font-mono text-[10px] text-slate-400">{task.id}</span><span className="text-[10px] text-slate-400">{timeLabel(task.updatedAt)}</span></div><h3 className="mt-2 text-sm font-semibold text-[#233b50]">{task.featureTitle || task.featureId}</h3><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-600">{task.task}</p>{task.suggestion && <div className="mt-3 rounded-lg border border-[#e5eaf0] bg-[#fbfcfd] p-3"><div className="mb-1 text-[10px] font-semibold text-slate-500">AI 建议</div><p className="whitespace-pre-wrap text-xs leading-5 text-slate-700">{task.suggestion}</p></div>}{editingTask === task.id && <textarea value={suggestionDraft} onChange={(event) => setSuggestionDraft(event.target.value)} placeholder="粘贴 AI 的分析结果或修改建议" className="mt-3 min-h-24 w-full rounded-lg border border-slate-200 p-3 text-xs outline-none focus:border-[#7fa4bf]" />}</div>
            <div className="flex flex-row items-center gap-2 lg:flex-col lg:items-stretch"><select value={task.status} onChange={(event) => void updateTask(task, { status: event.target.value as Status })} className="rounded-lg border border-[#e1e6eb] bg-white px-2.5 py-2 text-xs text-slate-700">{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{editingTask === task.id ? <button onClick={() => { void updateTask(task, { suggestion: suggestionDraft, status: "review" }); setEditingTask(null); }} className="rounded-lg bg-[#17334c] px-3 py-2 text-xs font-semibold text-white">保存建议</button> : <button onClick={() => { setEditingTask(task.id); setSuggestionDraft(task.suggestion); }} className="rounded-lg border border-[#dfe5ea] px-3 py-2 text-xs text-slate-600 hover:bg-slate-50">回填 AI 结果</button>}<button onClick={() => { const item = items.find((row) => row.id === task.featureId); if (item) void copyTaskPrompt(item); }} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#dfe5ea] px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"><Copy size={13} />复制上下文</button></div>
          </article>)}</div>}</section>}
        {view === "history" && <section className="overflow-hidden rounded-2xl border border-[#e3e8ed] bg-white shadow-[0_2px_12px_rgb(27_46_62/3%)]"><div className="border-b border-[#e9edf1] px-5 py-4"><h2 className="text-sm font-semibold">最近修改</h2><p className="mt-1 text-[11px] text-slate-500">记录保留在服务端，可随 JSON 备份导出。</p></div>{loading ? <LoadingState /> : events.length === 0 ? <div className="px-6 py-16 text-center text-xs text-slate-500">还没有修改记录。</div> : <div className="divide-y divide-[#edf0f3]">{events.map((event) => <EventCard key={event.id} event={event} />)}</div>}</section>}
      </main>
    </div>
    {panelOpen && <div className="dialog-backdrop fixed inset-0 z-40 flex justify-end" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanelOpen(false); }}><aside className="soft-shadow flex h-full w-full max-w-[560px] flex-col overflow-y-auto bg-white">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#e5e9ee] bg-white px-5 py-4"><div><div className="text-[10px] font-semibold uppercase tracking-[.1em] text-slate-400">{panelItem ? panelItem.id : "新需求"}</div><h2 className="mt-1 text-base font-semibold">{panelItem ? "编辑功能需求" : "新增功能需求"}</h2></div><button onClick={() => setPanelOpen(false)} aria-label="关闭" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={17} /></button></div>
      <form onSubmit={(event) => void saveFeature(event)} className="space-y-4 p-5">
        <div><label className="mb-1.5 block text-xs font-medium text-slate-700">功能名称 <span className="text-rose-500">*</span></label><input autoFocus required value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} className="w-full rounded-lg border border-[#dfe5ea] px-3 py-2.5 text-sm outline-none focus:border-[#7fa4bf]" placeholder="例如：工具外链有效性巡检" /></div>
        <div className="grid gap-3 sm:grid-cols-2"><div><label className="mb-1.5 block text-xs font-medium text-slate-700">所属模块</label><input value={draft.module} onChange={(event) => setDraft((current) => ({ ...current, module: event.target.value }))} className="w-full rounded-lg border border-[#dfe5ea] px-3 py-2.5 text-xs outline-none focus:border-[#7fa4bf]" /></div><div><label className="mb-1.5 block text-xs font-medium text-slate-700">目标版本</label><select value={draft.targetVersion} onChange={(event) => setDraft((current) => ({ ...current, targetVersion: event.target.value }))} className="w-full rounded-lg border border-[#dfe5ea] bg-white px-3 py-2.5 text-xs">{versions.map((version) => <option key={version}>{version}</option>)}</select></div></div>
        <div><label className="mb-1.5 block text-xs font-medium text-slate-700">功能说明</label><textarea value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} rows={4} className="w-full resize-y rounded-lg border border-[#dfe5ea] px-3 py-2.5 text-xs leading-5 outline-none focus:border-[#7fa4bf]" placeholder="写清用户要完成什么，以及功能会提供什么结果。" /></div>
        <div><label className="mb-1.5 block text-xs font-medium text-slate-700">本轮决策</label><div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{decisions.map((choice) => <button type="button" key={choice.value} onClick={() => setDraft((current) => ({ ...current, decision: choice.value }))} className={"rounded-lg border px-2 py-2 text-[10px] font-semibold transition " + (draft.decision === choice.value ? choice.tone + " border-current" : "border-[#e2e7ec] text-slate-500 hover:bg-slate-50")}>{choice.label}</button>)}</div></div>
        <div><label className="mb-1.5 block text-xs font-medium text-slate-700">修改意见 / 决策理由</label><textarea value={draft.decisionNote} onChange={(event) => setDraft((current) => ({ ...current, decisionNote: event.target.value }))} rows={3} className="w-full resize-y rounded-lg border border-[#dfe5ea] px-3 py-2.5 text-xs leading-5 outline-none focus:border-[#7fa4bf]" placeholder="为什么保留、修改、延后或删除？" /></div>
        <div className="flex justify-end gap-2 border-t border-[#edf0f3] pt-4"><button type="button" onClick={() => setPanelOpen(false)} className="rounded-lg border border-[#dfe5ea] px-4 py-2 text-xs text-slate-600">取消</button><button disabled={busy} type="submit" className="inline-flex items-center gap-2 rounded-lg bg-[#17334c] px-4 py-2 text-xs font-semibold text-white disabled:opacity-60">{busy && <LoaderCircle size={13} className="animate-spin" />}保存需求</button></div>
      </form>
      {panelItem && <div className="border-t border-[#e9edf1] px-5 py-5"><div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-semibold">AI 协作</h3><p className="mt-1 text-[11px] text-slate-500">任务上下文只包含当前功能，结果由你审核。</p></div><button onClick={() => void copyTaskPrompt(panelItem)} className="inline-flex items-center gap-1.5 rounded-lg border border-[#dfe5ea] px-2.5 py-2 text-[10px] text-slate-600"><Copy size={12} />复制上下文</button></div>
        <form onSubmit={(event) => void createTask(event)} className="rounded-xl border border-[#e2e7ec] bg-[#fbfcfd] p-3.5"><div className="mb-2 grid grid-cols-[140px_1fr] gap-2"><select value={taskModel} onChange={(event) => setTaskModel(event.target.value)} className="rounded-md border border-[#dfe5ea] bg-white px-2 py-2 text-[11px]">{Object.entries(modelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><textarea required rows={2} value={taskText} onChange={(event) => setTaskText(event.target.value)} className="resize-y rounded-md border border-[#dfe5ea] bg-white px-2.5 py-2 text-[11px] outline-none focus:border-[#7fa4bf]" placeholder="给 AI 的具体任务，例如：分析这项需求的商业价值" /></div><div className="flex justify-end"><button disabled={busy || !taskText.trim()} className="rounded-md bg-[#356f9e] px-3 py-2 text-[10px] font-semibold text-white disabled:opacity-50">创建 AI 任务</button></div></form>
        <div className="mt-4 space-y-3">{tasks.filter((task) => task.featureId === panelItem.id).map((task) => <div key={task.id} className="rounded-lg border border-[#e7ebef] p-3"><div className="flex items-center justify-between"><div className="flex items-center gap-2 text-[10px] font-semibold text-slate-600"><Bot size={13} className="text-[#356f9e]" />{modelLabels[task.model]} · {statusLabels[task.status]}</div><button onClick={() => { setPanelOpen(false); setView("ai"); setEditingTask(task.id); setSuggestionDraft(task.suggestion); }} className="text-[10px] text-[#356f9e]">查看任务</button></div><p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[11px] leading-5 text-slate-600">{task.task}</p>{task.suggestion && <p className="mt-2 line-clamp-3 whitespace-pre-wrap border-t border-[#edf0f3] pt-2 text-[11px] leading-5 text-slate-500">{task.suggestion}</p>}</div>)}</div>
      </div>}
    </aside></div>}
  </div>;
}

function Metric({ label, value, detail, icon, tone }: { label: string; value: number; detail: string; icon: React.ReactNode; tone: string }) {
  const colors: Record<string, string> = { blue: "bg-[#eef4f8] text-[#356f9e]", green: "bg-emerald-50 text-emerald-700", amber: "bg-amber-50 text-amber-700", slate: "bg-slate-100 text-slate-600" };
  return <div className="rounded-xl border border-[#e4e9ee] bg-white p-4"><div className="flex items-start justify-between"><div><div className="text-[11px] text-slate-500">{label}</div><div className="mt-2 text-[25px] font-semibold tracking-tight text-[#1c3449]">{value}</div></div><div className={"grid h-9 w-9 place-items-center rounded-lg " + colors[tone]}>{icon}</div></div><div className="mt-2 text-[10px] text-slate-400">{detail}</div></div>;
}
function Select({ value, onChange, options, labels = {} }: { value: string; onChange: (value: string) => void; options: string[]; labels?: Record<string, string> }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} className="focus-ring max-w-[150px] rounded-lg border border-[#e2e7ec] bg-white px-2.5 py-2 text-[10px] text-slate-600 outline-none">{options.map((option) => <option key={option} value={option}>{labels[option] || option}</option>)}</select>;
}
function LoadingState() {
  return <div className="flex items-center justify-center gap-2 px-6 py-16 text-xs text-slate-500"><LoaderCircle className="animate-spin" size={16} />正在读取云端数据…</div>;
}
function EmptyState({ onSeed, onCreate, busy }: { onSeed: () => void; onCreate: () => void; busy: boolean }) {
  return <div className="px-5 py-14 text-center"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#eef4f8] text-[#356f9e]"><FilePlus2 size={24} /></div><h3 className="mt-4 text-sm font-semibold">工作区还是空的</h3><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500">可以从工具模块草案开始，也可以手动新增需求或导入 JSON。</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button disabled={busy} onClick={onSeed} className="inline-flex items-center gap-2 rounded-lg bg-[#17334c] px-3.5 py-2.5 text-xs font-semibold text-white disabled:opacity-50"><Sparkles size={14} />载入工具模块草案</button><button onClick={onCreate} className="rounded-lg border border-[#dfe5ea] bg-white px-3.5 py-2.5 text-xs font-medium text-slate-600">新增空白需求</button></div></div>;
}
function EventCard({ event }: { event: EventRow }) {
  let data: Record<string, unknown> = {};
  try { data = event.afterJson ? JSON.parse(event.afterJson) as Record<string, unknown> : {}; } catch { data = {}; }
  const labels: Record<string, string> = { created: "新增需求", updated: "更新记录", seeded_tool_module: "载入草案", json_import: "导入 JSON" };
  const detail = typeof data.title === "string" ? data.title : typeof data.count === "number" ? "载入 " + data.count + " 条初始需求" : event.entityId;
  return <div className="flex gap-3 px-5 py-4"><div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#eef4f8] text-[#356f9e]"><History size={14} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-slate-700">{labels[event.action] || event.action}</span><span className="font-mono text-[10px] text-slate-400">{event.entityId}</span><span className="ml-auto text-[10px] text-slate-400">{timeLabel(event.createdAt)}</span></div><p className="mt-1 truncate text-[11px] text-slate-500">{detail}</p></div></div>;
}
