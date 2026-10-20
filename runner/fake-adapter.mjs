/** A deterministic executor for local Runner protocol tests; it never calls a model. */
export function createFakeAdapter({ delayMs = 0, failWith } = {}) {
  return {
    name: "fake",
    async execute({ run, task, workspace, signal, onEvent }) {
      await onEvent({ type: "executor.started", message: `Fake executor started ${task.id}` });
      if (delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); }, { once: true });
        });
      }
      if (signal?.aborted) throw signal.reason || new Error("aborted");
      if (failWith) throw new Error(failWith);
      const summary = `Fake executor completed ${task.id} in ${workspace} (Run ${run.id})`;
      await onEvent({ type: "executor.completed", message: summary });
      return { summary, evidence: [{ kind: "runner-test", name: "fake-adapter", detail: "No model or external process was invoked." }] };
    },
  };
}
