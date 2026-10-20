import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentAdapter } from "../runner/agent-adapters.mjs";
import { createFakeAdapter } from "../runner/fake-adapter.mjs";
import { runRunner } from "../runner/runner-core.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fallbackRepositoryPath = path.resolve(process.env.WORKBENCH_REPOSITORY || projectRoot);
const runnerDirectory = path.resolve(process.env.WORKBENCH_RUNNER_DIR || path.join(projectRoot, "work", "runner"));
const apiBase = process.env.WORKBENCH_RUNNER_API || "http://127.0.0.1:4179";
const runnerId = process.env.WORKBENCH_RUNNER_ID || `local-${process.pid}`;
const adapterName = process.env.WORKBENCH_RUNNER_ADAPTER || "auto";
const adapter = adapterName === "fake" ? createFakeAdapter({ delayMs: Number(process.env.WORKBENCH_FAKE_DELAY_MS || 0) }) : (claim, launch) => createAgentAdapter(claim.run?.executorType || claim.task?.executorType || claim.task?.provider, launch);
// "custom:*" = every agent the person added on the settings page (their definitions come with each claim).
const capabilities = adapterName === "fake" ? ["fake"] : adapterName === "auto" ? ["claude", "claude-code", "codex", "custom:*"] : [adapterName];
async function resolveRepositoryPath() {
  if (process.env.WORKBENCH_REPOSITORY) return fallbackRepositoryPath;
  try {
    const response = await fetch(new URL("/api/settings", apiBase), { cache: "no-store" });
    if (!response.ok) throw new Error(`settings API returned ${response.status}`);
    const settings = await response.json();
    return path.resolve(settings.projectPath || fallbackRepositoryPath);
  } catch {
    return fallbackRepositoryPath;
  }
}

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
console.log(`[runner] ${runnerId} polling ${apiBase}; adapter=${adapterName}; repo=${fallbackRepositoryPath}`);
await runRunner({ apiBase, runnerId, repositoryPath: fallbackRepositoryPath, resolveRepositoryPath, runnerDirectory, capabilities, leaseSeconds: Number(process.env.WORKBENCH_RUNNER_LEASE_SECONDS || 60), adapter, signal: controller.signal });
