# Windows Computer Use Design

This document defines the Windows-only Computer Use direction for the custom runtime and records the external implementation patterns reviewed before expanding M3.

## Scope decision

Windows is the only active target for new Computer Use work in this fork.

- Do not add new macOS or Linux Computer Use capabilities.
- Preserve existing upstream macOS/Linux code when removal would create unnecessary churn, but do not let those platforms expand the implementation surface or block Windows-focused design choices.
- Windows CI remains useful for pure unit/integration validation, but real desktop-control verification belongs in the user's interactive Windows/VMware environment rather than a headless GitHub runner.

## Repositories reviewed

### Microsoft UFO

Useful patterns:

- Uses a distinct UI inspection layer and action/controller layer rather than mixing observation and input.
- On Windows, combines Win32 top-level window discovery with UI Automation (UIA) for semantic control inspection.
- Avoids repeatedly walking UIA properties one-by-one: the UIA inspector bulk-fetches and caches control type, name, and bounding rectangle, and caps the amount of returned UI data.
- Uses semantic UIA actions when possible and coordinate/global-input fallbacks when needed.
- Screenshot capture is layered: control/window capture first, then `PrintWindow`, then desktop capture as a fallback. Captures are validated before being trusted.

What we should borrow:

- Win32 window discovery + UIA semantic inspection.
- Bulk/cached UIA property collection.
- Semantic-target-first, coordinate-fallback-second execution.
- Layered screenshot capture with validation and explicit fallbacks.

What we should not import directly:

- Python, `pywinauto`, `pyautogui`, or the UFO runtime itself. Adding a Python runtime just for Computer Use would widen packaging and failure modes unnecessarily.

### UI-TARS Desktop

Useful patterns:

- Defines an Operator-style boundary between `screenshot()` and `execute(action)`.
- Keeps a compact action space such as click, double-click, right-click, drag, type, hotkey, scroll, wait, and finish.
- Explicitly handles screen scale / pixel-density when mapping model coordinates to physical desktop coordinates.
- Its NutJS operator demonstrates a small cross-platform action implementation surface.

What we should borrow:

- A small Operator/backend interface.
- Explicit coordinate scaling/DPI normalization.
- A compact action vocabulary rather than exposing raw Win32 primitives directly to the model.

What we should not adopt initially:

- `@computer-use/nut-js` as the primary backend. It would add a native npm dependency while our existing control layer already requires stricter app/foreground verification than a generic global mouse/keyboard operator provides.
- Clipboard-based Windows typing as the normal path. Our current Unicode `SendInput` path avoids temporarily replacing the user's clipboard.

### Microsoft PowerToys

Useful patterns:

- PowerToys contains mature Windows overlay/frame implementations using native topmost/no-activate windows and Direct2D/Win32 drawing.
- Its overlay modules demonstrate the relevant window styles for visual indicators that must not steal focus or interfere with mouse input.

What we should borrow:

- Native Win32 overlay window rather than adding an Electron/UI framework dependency solely for an activity border.
- `WS_EX_TOPMOST`, `WS_EX_TOOLWINDOW`, `WS_EX_NOACTIVATE`, layered rendering, and click-through behavior.
- DPI-aware border rendering.

### OpenAI Codex

The public `openai/codex` repository contains native Computer Use configuration/protocol/activity code, but the Windows desktop UI implementation that draws the subtle full-screen Computer Use activity border was not located in the public source reviewed here. We therefore reproduce the user-visible behavior using standard Windows overlay techniques rather than depending on private Codex UI details.

## Chosen architecture

Keep the existing `chatgpt2codex` control plane and replace only the platform backend pieces required for Windows.

```text
ChatGPT Computer Use tools
        |
        v
existing control plane
  - control lease
  - allowlist / sensitive target checks
  - approval queue
  - kill switch
  - audit ledger
        |
        v
Windows Computer Use backend
  +-- observe
  |    +-- app/window discovery
  |    +-- app-window screenshot
  |    +-- UIA snapshot
  |
  +-- act
  |    +-- activate exact target window
  |    +-- semantic UIA action when available
  |    +-- coordinate fallback
  |    +-- mouse / keyboard / scroll / drag
  |
  +-- activity indicator
       +-- non-activating click-through screen border
```

Do not create a second Computer Use orchestration stack. Queueing, permission, safety, and audit stay in the existing control layer.

## Windows backend process

Continue with the persistent Windows helper rather than launching PowerShell/C# for every action.

```text
Node runtime
   |
   | JSON-lines local IPC
   v
persistent Windows helper
   +-- Win32 window enumeration / activation
   +-- SendInput
   +-- UI Automation
   +-- screenshot capture
   +-- activity indicator
```

Model/user-controlled strings are data over stdin, never interpolated into PowerShell/C# source or command-line arguments.

The helper is a platform implementation detail. Main Core and Web-worker correctness must not depend on it being available.

## Observation pipeline

### Window discovery

Use Win32 enumeration as the fast outer layer. For each candidate retain only the minimum useful metadata:

- HWND-local opaque runtime id
- process id / executable identity
- title
- visible state
- window bounds
- foreground state

The model should not receive arbitrary handles as authority. Any action must re-resolve and revalidate the target immediately before execution.

### UI Automation snapshot

For the selected app/window, query UIA descendants in one bounded snapshot.

Initial fields:

- local element id valid only for the snapshot
- name
- control type
- bounding rectangle
- enabled
- offscreen/visible state
- selected useful patterns/actions where cheap to query

Rules:

- Bulk/cache UIA properties rather than issuing a COM call for every property of every element.
- Cap snapshot size (initial target: 500 elements, matching the scale used by UFO unless testing shows a smaller bound is better).
- Filter empty, invisible, offscreen, and irrelevant elements early.
- Element ids are ephemeral observation ids, not durable authorization identifiers.
- Before executing against a semantic element, revalidate that it still belongs to the intended allowlisted app/window.

### Screenshot

For ChatGPT-exposed Computer Use, prefer an explicitly selected allowlisted app window rather than unrestricted full-screen capture.

Initial capture order:

1. capture the selected window directly;
2. `PrintWindow(PW_RENDERFULLCONTENT)` where suitable;
3. visible-window screen-region capture when direct window capture is invalid;
4. unrestricted full-screen capture remains local/manual-only until its privacy model is separately proven.

Validate every capture for non-zero dimensions and non-empty output before returning it.

A later Windows Graphics Capture implementation may replace or supplement `PrintWindow` for GPU-heavy apps if live testing shows black/empty captures.

## Action pipeline

Prefer semantic UIA actions when the target exposes a reliable pattern. Examples include invoke/click, set value, selection, and focus.

Fallback to coordinate input only when semantic execution is unavailable or the caller intentionally requested a coordinate action.

Before any coordinate or keyboard action:

1. resolve the target app/window again;
2. verify the allowlist/sensitive-target policy again;
3. activate the exact target window;
4. verify it actually became foreground;
5. transform window-relative or screenshot-relative coordinates using current DPI/scale;
6. execute input;
7. record evidence/result in the existing audit path.

Do not silently send input to whichever window happens to be foreground.

## Computer Use activity border

Add a visual indicator similar in purpose to the Codex Computer Use border.

### User-visible behavior

While Computer Use is actively observing or acting, show a subtle border around the controlled desktop/monitor area with a small non-interactive label such as `Computer Use`.

The first version should be intentionally quiet:

- thin border;
- low visual intensity;
- no focus stealing;
- no taskbar button;
- no mouse/keyboard interception;
- disappear promptly when Computer Use becomes idle or is killed.

Possible later states may distinguish `waiting for approval`, `executing`, and `killed`, but M3 should start with a single active state.

### Implementation

Implement the indicator in the persistent Windows helper with one native overlay per monitor (or a single virtual-screen overlay if the first implementation is materially simpler).

Recommended extended styles:

```text
WS_EX_TOPMOST
WS_EX_TOOLWINDOW
WS_EX_NOACTIVATE
WS_EX_LAYERED
WS_EX_TRANSPARENT
```

Additional behavior:

- `WS_POPUP` borderless windows;
- show without activation (`SW_SHOWNA`);
- hit testing returns `HTTRANSPARENT` as defense in depth;
- DPI-aware monitor bounds/thickness;
- no entry in Alt-Tab/taskbar;
- best-effort `SetWindowDisplayAffinity(..., WDA_EXCLUDEFROMCAPTURE)` so our own Computer Use indicator does not contaminate screenshots supplied back to the model;
- if capture exclusion is unavailable, temporarily hide only the indicator during screenshot acquisition.

### Lifecycle

Treat the indicator as UX, not authorization.

```text
Computer Use operation begins
    -> activity indicator acquire/refcount
    -> observe / act
    -> release
    -> short idle debounce
    -> hide
```

A crash or indicator failure must never leave the control lease in a more permissive state. Conversely, absence of the border must never be interpreted as permission to act.

## Dependency decision

For M3, do not add NutJS, pywinauto, Python, or a second desktop framework.

Keep:

- TypeScript/Node orchestration;
- the persistent native Windows helper;
- direct Win32/UIA implementation behind a small backend interface.

Reconsider a third-party native automation dependency only if live Windows testing reveals a specific reliability problem that it clearly solves with less total complexity than the direct backend.

## M3 implementation sequence

### M3.1 - Windows backend foundation

- stabilize persistent helper IPC/lifecycle;
- window resolve/activate;
- mouse, Unicode typing, hotkeys/keys;
- platform backend interface;
- pure/unit tests in CI; live-input smoke tests only on interactive Windows.

### M3.2 - Windows observation

- app/window enumeration;
- app-window screenshot pipeline;
- DPI/coordinate normalization;
- screenshot validation and privacy gates.

### M3.3 - UIA semantic layer

- bounded cached UIA snapshot;
- semantic target ids scoped to one observation;
- invoke/set-value/focus/selection where available;
- coordinate fallback preserved.

### M3.4 - Activity indicator

- click-through topmost border overlay;
- exclude/hide overlay from screenshots;
- tie lifecycle to Computer Use operation activity;
- kill/cancel always clears it.

### M3.5 - VMware live smoke validation

Validate on the actual Windows VM:

- Notepad/basic text app;
- Explorer;
- browser;
- multi-window focus switching;
- screenshot -> target -> action loop;
- DPI scaling;
- activity border visibility and click-through behavior;
- kill switch/cancel;
- repeated sessions without stale helper/overlay state.
