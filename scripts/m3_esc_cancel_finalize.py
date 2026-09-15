from pathlib import Path
import subprocess

# The staging patch originally added a focused CI entry, but GitHub's GITHUB_TOKEN
# cannot update workflow files without the workflows permission. Keep CI unchanged
# and place the cancellation assertions in activity-indicator.test.ts, which the
# existing Windows-focused CI already runs.
subprocess.run(["git", "checkout", "--", ".github/workflows/ci.yml"], check=True)

cancel_test = Path('src/control/cancel.test.ts')
if cancel_test.exists():
    cancel_test.unlink()

p = Path('src/control/activity-indicator.test.ts')
s = p.read_text(encoding='utf-8')
import_marker = 'import {\n  __getComputerUseActivityStateForTests,'
cancel_import = '''import {\n  __resetComputerUseCancelForTests,\n  assertComputerUseNotRecentlyCancelled,\n  computerUseCancelGeneration,\n  signalComputerUseCancel,\n  waitForComputerUseDelay,\n  wasComputerUseCancelledSince,\n} from "./cancel.js";\nimport { ErrorCode } from "../types.js";\nimport {\n  __getComputerUseActivityStateForTests,'''
if import_marker not in s:
    raise SystemExit('activity test import marker missing')
s = s.replace(import_marker, cancel_import, 1)

old = '''  afterEach(async () => {\n    __setComputerUseActivityDriverForTests(undefined);\n    await stopWindowsActivityIndicatorHelper();\n  });'''
new = '''  afterEach(async () => {\n    __setComputerUseActivityDriverForTests(undefined);\n    __resetComputerUseCancelForTests();\n    await stopWindowsActivityIndicatorHelper();\n  });'''
if old not in s:
    raise SystemExit('activity afterEach marker missing')
s = s.replace(old, new, 1)

insert_at = '\n});\n\nif (process.platform === "win32") {'
extra = r'''

  it("records local Esc cancellation and rejects immediate follow-up control", () => {
    __resetComputerUseCancelForTests({ latchMs: 5_000 });
    const before = computerUseCancelGeneration();
    signalComputerUseCancel("escape");
    expect(wasComputerUseCancelledSince(before)).toBe(true);
    try {
      assertComputerUseNotRecentlyCancelled();
      throw new Error("expected cancellation");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ErrorCode.CONTROL_CANCELLED);
    }
  });

  it("interrupts screenshot-style waits immediately on local Esc", async () => {
    const before = computerUseCancelGeneration();
    const started = Date.now();
    const pending = waitForComputerUseDelay(5_000, before);
    setTimeout(() => signalComputerUseCancel("escape"), 20);
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.CONTROL_CANCELLED });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
'''
if insert_at not in s:
    raise SystemExit('activity describe end marker missing')
s = s.replace(insert_at, extra + insert_at, 1)
p.write_text(s, encoding='utf-8')
