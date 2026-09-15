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
