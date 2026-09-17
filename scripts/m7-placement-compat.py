from pathlib import Path

path = Path("src/agents/manager.ts")
text = path.read_text(encoding="utf-8")
old = '''  await pinBrowserWorkerPlacement(
    stateDir,
    worker.workerId,
    worker.projectId,
    input.placement,
  );
'''
new = '''  if (input.placement || process.env.CHATGPT2CODEX_WORKER_PROJECT_URL?.trim()) {
    await pinBrowserWorkerPlacement(
      stateDir,
      worker.workerId,
      worker.projectId,
      input.placement,
    );
  }
'''
if text.count(old) != 1:
    raise RuntimeError(f"expected one manager placement block, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("M7 placement compatibility adjustment applied")
