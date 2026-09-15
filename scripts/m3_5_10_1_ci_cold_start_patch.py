from pathlib import Path

# Give persistent PowerShell/Add-Type helpers enough cold-start budget on a
# heavily contended hosted Windows runner. Runtime request timeouts stay short;
# only process startup gets the larger budget.
for file, old, new in [
    ('src/control/win-native.ts', 'const STARTUP_TIMEOUT_MS = 90_000;', 'const STARTUP_TIMEOUT_MS = 120_000;'),
    ('src/control/win-uia.ts', 'const STARTUP_TIMEOUT_MS = 60_000;', 'const STARTUP_TIMEOUT_MS = 120_000;'),
    ('src/control/activity-indicator.ts', 'const STARTUP_TIMEOUT_MS = 60_000;', 'const STARTUP_TIMEOUT_MS = 120_000;'),
    ('src/control/win-native.test.ts', '    }, 110_000);', '    }, 150_000);'),
    ('src/control/win-uia.test.ts', '    }, 75_000);', '    }, 150_000);'),
    ('src/control/activity-indicator.test.ts', '    }, 75_000);', '    }, 150_000);'),
]:
    path = Path(file)
    text = path.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing anchor in {file}: {old}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')

# On Windows, the three native helper test files each cold-compile PowerShell/C#.
# Running them in parallel makes Add-Type contend for CPU/compiler resources and
# caused unrelated 60-75s startup timeouts. Keep the ordinary test suite together,
# then run each native helper test file as its own sequential CI step.
ci = Path('.github/workflows/ci.yml')
text = ci.read_text(encoding='utf-8')
old = '''      - name: Agent and platform-safe tests\n        run: npx vitest run src/agents src/state/store.test.ts src/server/agent-tools.test.ts src/server/agent-piggyback.test.ts src/server/web-agent-tools.test.ts src/server/web-agent-stop-tool.test.ts src/server/web-agent-recovery.test.ts src/server/web-agent-parallel.test.ts src/control/win-native.test.ts src/control/win-uia.test.ts src/control/activity-indicator.test.ts\n'''
new = '''      - name: Agent and platform-safe tests\n        if: matrix.os != 'windows-latest'\n        run: npx vitest run src/agents src/state/store.test.ts src/server/agent-tools.test.ts src/server/agent-piggyback.test.ts src/server/web-agent-tools.test.ts src/server/web-agent-stop-tool.test.ts src/server/web-agent-recovery.test.ts src/server/web-agent-parallel.test.ts src/control/win-native.test.ts src/control/win-uia.test.ts src/control/activity-indicator.test.ts\n\n      - name: Agent tests (Windows)\n        if: matrix.os == 'windows-latest'\n        run: npx vitest run src/agents src/state/store.test.ts src/server/agent-tools.test.ts src/server/agent-piggyback.test.ts src/server/web-agent-tools.test.ts src/server/web-agent-stop-tool.test.ts src/server/web-agent-recovery.test.ts src/server/web-agent-parallel.test.ts\n\n      - name: Windows native input helper test\n        if: matrix.os == 'windows-latest'\n        run: npx vitest run src/control/win-native.test.ts\n\n      - name: Windows UIA helper test\n        if: matrix.os == 'windows-latest'\n        run: npx vitest run src/control/win-uia.test.ts\n\n      - name: Windows activity indicator helper test\n        if: matrix.os == 'windows-latest'\n        run: npx vitest run src/control/activity-indicator.test.ts\n'''
if old not in text:
    raise SystemExit('CI test step anchor missing')
ci.write_text(text.replace(old, new, 1), encoding='utf-8')
