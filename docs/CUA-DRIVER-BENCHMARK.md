# Cua Driver backend and Computer Use A/B benchmark

This branch adds an **optional** Cua Driver backend without deleting the existing
Windows implementation. The chatgpt2codex control plane remains authoritative:
control leases, app allowlists, sensitive-target checks, approval queues, the
kill switch, masking, and the audit ledger are unchanged.

## Select a backend

The existing implementation remains the default:

```powershell
$env:CHATGPT2CODEX_WINDOWS_BACKEND = "legacy"
```

To route Windows observation and input through a locally installed Cua Driver:

```powershell
$env:CHATGPT2CODEX_WINDOWS_BACKEND = "cua"
```

The adapter starts one persistent `cua-driver mcp` stdio connection because
Cua element tokens and snapshots are connection-scoped. If the binary is not on
`PATH`, set:

```powershell
$env:CUA_DRIVER_BIN = "C:\path\to\cua-driver.exe"
```

The child is launched with Cua telemetry disabled. The synthetic Cua agent
cursor is also disabled by default because its awaited glide animation was
measured on the action critical path. To enable the visual cursor for demos or
screen recordings, set:

```powershell
$env:CHATGPT2CODEX_CUA_CURSOR_OVERLAY = "1"
```

This changes only the visualization; semantic targeting and background delivery
remain unchanged. chatgpt2codex does not bundle, download, or silently install
Cua Driver.

## Action policy

The Cua backend keeps the current public `computer_*` contracts. A Cua
`get_window_state` response is mapped into the existing Windows semantic
observation shape, and its opaque `element_token` is carried inside the
existing `target.ax.label` field.

Actions use this policy:

1. semantic element action when an element token is available; text-field
   replacement maps to Cua `set_value` (UIA `ValuePattern.SetValue`), matching
   the legacy backend rather than cursor-oriented `type_text`;
2. Cua `delivery_mode:"background"` first;
3. retry the same action with `delivery_mode:"foreground"` only when Cua
   explicitly reports `background_unavailable`;
4. otherwise fail without silently switching execution systems.

The old `win-native` / `win-uia` implementation stays intact for instant
rollback. Executor before/after evidence captures use Cua's screenshot-only
path so they do not replace the semantic snapshot that an approved element
token is bound to.

## Run the deterministic A/B benchmark

Run this from an **interactive Windows desktop**, not a headless CI runner.
The normal benchmark now uses the production Cua default (cursor overlay off):

```powershell
npm run benchmark:computer-use -- --iterations 20
```

Use `--cua-overlay both` when explicitly comparing the visualization cost.

The runner compiles and opens a tiny uniquely-named WinForms fixture executable
so the legacy app-name resolver cannot collide with the PowerShell console that
built/launched the old fixture. It uses exactly the same task for both backends.
The runner mirrors the production executor: semantic actuation is preferred,
but a coordinate target is used when the selected backend cannot expose or
execute a semantic action:

- capture the target app window;
- obtain a semantic element observation;
- write a unique token into a textbox;
- independently verify the textbox value from the fixture state file;
- re-observe the window (one action per semantic snapshot);
- invoke a Submit button;
- independently verify the submitted token.

It also opens Notepad as a foreground decoy. Before both the type and click
actions it restores the decoy to the foreground, then records whether the
backend preserved foreground focus.

Outputs are written under `.chatgpt2codex/benchmarks/` as JSON plus a Markdown
summary. The report includes:

- task success rate;
- median and p95 end-to-end latency;
- initial observation/type/re-observation/click latency;
- type-application rate and submit-application rate;
- semantic-vs-coordinate route rate for type and click;
- type and click foreground-preservation rate;
- Cua tool-call count;
- background attempts;
- explicit foreground escalations;
- failures;
- per-tool Cua latency for `list_windows` and `get_window_state`;
- target-window resolution average;
- observation normalization average;
- semantic-snapshot cache-hit count.

The first iteration of each backend is a warm-up and is excluded from summary
statistics.

### WinForms coverage note

A live Windows probe showed why route reporting matters. The legacy
`System.Windows.Automation` helper observed the fixture's classic
`WindowsForms10.EDIT` and `WindowsForms10.BUTTON` controls only as `Pane`
elements with no advertised actions. Cua Driver successfully operated the same
fixture semantically. The benchmark therefore does not call the legacy backend
"unavailable" solely because semantic metadata is sparse; it exercises the
same coordinate fallback used by the production executor and reports the route
separately.

### Run only one backend

```powershell
npm run benchmark:computer-use -- --backends legacy --iterations 20
npm run benchmark:computer-use -- --backends cua --iterations 20
```

### Custom output path

```powershell
npm run benchmark:computer-use -- --output .\results\cu-ab.json
```

## Scope of this branch

This phase evaluates **Cua Driver itself**. It deliberately does not bundle the
draft `cua-perception` extension from trycua/cua PR #3943 and does not enable
Jev. Those are separate variables and should be benchmarked only after the
legacy-vs-Cua execution/observation baseline is established.

### Isolating Cua cursor-overlay latency

Cua Driver's Windows semantic `set_value` and element-click implementations
wait for the synthetic agent cursor to finish `overlay_glide_to(...)` before
actuating the UIA control. To measure that visual-animation cost independently,
run both Cua modes in the same process:

```powershell
npm run benchmark:computer-use -- --iterations 5 --cua-overlay both
```

The report emits separate `cua-overlay-on` and `cua-overlay-off` rows.
The OFF mode uses the official session-owned `set_agent_cursor_enabled` tool;
it does not change semantic targeting, background delivery, or the external
fixture-state verification. A large drop in Type/Click time with the overlay
off therefore isolates cursor-glide waiting from UIA actuation itself.

### Confirmed local result: overlay is the latency bottleneck

Same-machine Windows run (5 measured iterations):

| Backend | Median total | Type | Click | Type semantic | Click semantic | Type FG preserved | Click FG preserved |
|---|---:|---:|---:|---:|---:|---:|---:|
| legacy | 1147.28 ms | 246.17 ms | 196.50 ms | 0% | 0% | 0% | 0% |
| cua-overlay-on | 3989.38 ms | 1528.04 ms | 1528.91 ms | 100% | 100% | 100% | 100% |
| cua-overlay-off | 1153.50 ms | 111.94 ms | 112.00 ms | 100% | 100% | 100% | 100% |

Turning off only Cua's session-owned synthetic cursor reduced median total latency by
about 71% (3989.38 ms -> 1153.50 ms) while preserving 100% semantic routing,
100% functional success, and 100% foreground preservation. Type and click each
fell by about 13.6x. Cua with the overlay disabled is within about 0.5% of
legacy total latency on this fixture, despite Cua observation remaining slower
(~315 ms vs ~102 ms), because Cua semantic actuation itself is faster than
legacy's coordinate fallback on this case.

This confirms that the ~1.5 s semantic-action cost observed with Cua was not
UIA SetValue/Invoke or foreground-preservation overhead. It was the awaited
synthetic cursor glide on the action critical path.

Cua still reported all 12 warm-up/measured semantic actions as
`unverifiable` (0 confirmed / 12 unverifiable / 0 suspected-noop), while the
fixture independently verified all effects. Driver confidence handling remains
a separate follow-up from the latency issue.

### Observation timing decomposition

The benchmark's Observe phase intentionally captures the screenshot and
accessibility tree together. On Cua this means:

```text
resolveTargetWindow
  -> list_windows
get_window_state(include_screenshot=true, include_accessibility_tree=true)
  -> normalize/cache observation
snapshotSemanticElements
  -> cache hit
```

The report now prints aggregate Cua timing for `list_windows`,
`get_window_state`, target resolution, normalization, and snapshot cache hits.
This distinguishes Driver round-trip/UIA/capture cost from local normalization
and verifies whether the second semantic call is actually reusing the combined
observation.

### Removing repeated window discovery

The first observation-timing run showed:

```text
list_windows      109.39 ms avg (30 calls)
get_window_state  161.82 ms avg (12 calls)
target-resolve    107.82 ms avg (24)
normalize           0.10 ms avg (12)
snapshot-cache-hits 12
```

With 6 total runs including warm-up, the counts explain the path exactly:
12 captures plus 12 semantic pre-action window validations produced 24 target
resolutions, and the benchmark rediscovered the fixture once per run for the
remaining 6 `list_windows` calls.

The adapter now removes those repeated round trips in two ways:

1. semantic actions validate the exact opaque selector against the current
   observation cache (app, pid, window, snapshot, and selector membership)
   instead of calling `list_windows` again; Cua's snapshot-scoped token remains
   the final stale-target guard;
2. read-only capture/snapshot calls reuse a 2-second target cache populated by
   window discovery/observation. If that cached target is stale, only the
   read-only `get_window_state` call is retried after a fresh window lookup.
   Destructive actions are never automatically replayed.

The benchmark also resolves the deterministic fixture once per backend variant
instead of rediscovering it inside every measured iteration, because product
computer-use requests already carry an app identity. The Cua timing footer now
reports target-cache hits/misses alongside the existing tool timings.

### Splitting `get_window_state` cost

After removing repeated window discovery, the remaining same-machine Cua timing
was:

```text
list_windows=n/a
get_window_state=164.91ms avg
set_value=5.94ms avg
click=6.17ms avg
target-resolve=0ms
target-cache=12 hits/0 misses
normalize=0.10ms avg
snapshot-cache-hits=12
```

This confirms that semantic actuation itself is only ~6 ms and the remaining
latency is dominated by `get_window_state`.

Cua's Windows implementation performs the UIA tree walk and screenshot capture
sequentially inside one blocking `get_window_state` task. Use the optional
probe to measure the components and a split-parallel alternative without
changing the production observation path:

```powershell
npm run benchmark:computer-use -- --backends cua --iterations 5 --cua-observe-probe
```

The report adds one line with medians for:

- `combined`: current production-style tree + screenshot call;
- `tree-only`: `include_screenshot:false`;
- `screenshot-only`: `include_accessibility_tree:false`;
- `parallel`: tree-only and screenshot-only issued concurrently against the
  same already-resolved target window.

The probe runs only after the measured functional benchmark, so its extra calls
do not contaminate the normal Cua timing diagnostics. Production should only be
changed to a split/parallel observation path if this local probe shows a clear
wall-clock win while retaining the same semantic element coverage.

### Observation probe result: Cua internal validation is the remaining floor

Same-machine 5-sample result:

```text
combined        175.82 ms median
tree-only       156.98 ms
screenshot-only 130.94 ms
parallel         267.22 ms (p95 299.76 ms)
elements              7
```

The split-parallel path is rejected: it is ~52% slower than the combined call.
Cua's Windows `get_window_state` validates the supplied `(pid, window_id)`
on every call by enumerating the pid's windows, then resolves process metadata,
before doing the requested UIA walk and/or screenshot. Splitting the request
duplicates that common work and also introduces UIA/capture contention.

Combined with the earlier measured `list_windows` cost (~109 ms), the fixture
roughly decomposes as:

```text
Cua window/process validation  ~109 ms
UIA tree incremental cost       ~48 ms
screenshot incremental cost     ~19 ms
combined                        ~176 ms
```

This means the large adapter-side costs have been removed. On this fixture,
`max_elements` / `max_depth` are not the dominant issue (only 7 elements),
and screenshot downscaling can only attack the small screenshot increment.

Do not:
- split tree and screenshot into concurrent Cua calls;
- reuse a pre-action element token across actions merely to avoid observation.
  Cua's Windows guidance requires every action to be bracketed by a fresh
  window snapshot before/after so stale targets and silent no-ops are visible.

The next material reduction requires a Cua Driver change (for example, a safe
session/window validation cache or equivalent fast path inside
`get_window_state`) rather than another chatgpt2codex adapter optimization.
The existing `CUA_DRIVER_BIN` override can be used to benchmark such a Driver
build without changing the adapter contract.

### Patched Cua Driver exact-window fast path

The remaining observation floor is inside Cua Driver's Windows
**get_window_state**: even when the caller already supplies an exact
**(pid, window_id)**, the pinned Driver revision performs a full
**list_windows(Some(pid))** Win32+UIA enumeration before every observation.

The same upstream revision already contains a narrower helper,
**find_window_by_pid_and_handle(pid, hwnd)**, which validates exactly one native
HWND without entering the global UIA tree. This repository carries a minimal,
reproducible downstream patch that uses that helper on the normal path and
falls back to the original full enumeration only when the exact native probe
cannot represent the surface:

~~~text
patches/cua-driver/get-window-state-exact-window-fast-path.patch
~~~

The patch is pinned to upstream commit:

~~~text
9bbfa7dd3e27ca7f1861ede70aaca390174493f9
~~~

Build a release binary on Windows:

~~~powershell
npm run cua:build-fast-path
~~~

The build script clones the pinned upstream revision under the ignored
.chatgpt2codex/cua-driver-fast-path/ work area, verifies the patch with
git apply --check, runs Rust formatting/focused exact-window tests, and builds
cua-driver.exe in release mode.

For an official-vs-patched same-machine comparison:

~~~powershell
npm run benchmark:cua-fast-path
~~~

or, with explicit PowerShell parameters:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/benchmark-cua-driver-fast-path.ps1 -Iterations 5 -ObservationProbe
~~~

The A/B runner executes the installed cua-driver and the patched binary in
separate benchmark processes via CUA_DRIVER_BIN, preserving the adapter
contract and avoiding singleton/process contamination. It prints both rows plus
the get_window_state and median-total deltas.

The intended acceptance conditions are:

- functional success stays 100%;
- semantic Type/Click stay 100%;
- foreground preservation stays 100%;
- get_window_state falls materially below the official observation floor;
- no new stale-target or window-identity fallback failures appear.

#### Same-machine official vs patched result

5 measured iterations per binary, with the benchmark's normal warm-up excluded:

| Metric | Official | Patched |
|---|---:|---:|
| Functional success | 100% | 100% |
| Semantic Type / Click | 100% / 100% | 100% / 100% |
| Type / Click foreground preserved | 100% / 100% | 100% / 100% |
| Median total | 582.40 ms | 454.07 ms |
| P95 total | 599.87 ms | 552.55 ms |
| Observe | 185.98 ms | 129.70 ms |
| Reobserve | 189.52 ms | 136.72 ms |
| Type | 9.27 ms | 9.86 ms |
| Click | 8.82 ms | 9.04 ms |
| get_window_state average | 151.63 ms | 82.19 ms |

The exact-window validation fast path reduced average get_window_state latency
by 69.44 ms (45.8%) and reduced median end-to-end task latency by 128.33 ms
(22.0%) on this fixture. The semantic action timings remained effectively
unchanged, which isolates the gain to the observation path rather than
actuation.

The Driver still reported 0 confirmed / 12 unverifiable / 0 suspected-noop in
both variants while the external fixture verified all effects, so the
confidence-contract issue is unchanged and remains separate from this latency
work.

The remaining ~82 ms get_window_state cost now includes the exact HWND probe,
process metadata lookup, UIA traversal, screenshot capture, and Driver/MCP
overhead. The old ~109 ms list_windows measurement should therefore be treated
only as a rough proxy for the former common floor, not as an exact amount that
the patch was expected to remove.

This remains an experiment. The synthetic WinForms fixture now provides strong
evidence that the fast path is worthwhile, but do not replace the installed
Driver or change the default backend until the patched binary also passes
broader WinForms, WPF/WinUI, Notepad, and Electron/Chromium coverage.

### Order-balanced and broader compatibility validation

The fast-path runner now defaults to both driver orders and both deterministic
fixture types:

```powershell
npm run benchmark:cua-fast-path -- -SkipBuild
```

Default matrix:

```text
WinForms: official -> patched
WinForms: patched  -> official
WPF:      official -> patched
WPF:      patched  -> official
```

Each row still performs the full functional contract: external state
verification, semantic set-value/click routing, and foreground preservation.
The runner prints the raw rows, per-order deltas, and an order-balanced mean for
each fixture. This makes a warm-cache/second-run advantage visible instead of
implicitly attributing it to the patched Driver.

Narrow runs are also supported:

```powershell
npm run benchmark:cua-fast-path -- -SkipBuild -Order reverse -Fixture winforms
npm run benchmark:cua-fast-path -- -SkipBuild -Order both -Fixture wpf
```

A separate read-only real-app probe exercises the exact `(pid, HWND)`
observation path without typing or clicking:

```powershell
npm run benchmark:cua-real-app-fast-path
```

It launches:
- a uniquely named temporary Notepad document;
- Microsoft Edge with an isolated temporary user-data-dir and a unique local
  HTML title.

For each exact titled window, the probe repeatedly requests one combined
screenshot + accessibility snapshot and requires a non-empty screenshot,
snapshot id, and accessibility element set. It runs official/patched in both
orders and reports per-order latency deltas. The Edge process is isolated from
the user's normal profile; cleanup targets only the benchmark-launched process
tree.

The build helper now persists the release binary outside Cargo's large target
tree:

```text
.chatgpt2codex/bin/cua-driver-fast-path.exe
```

To discard Cargo intermediates after a successful build while keeping that
binary:

```powershell
npm run cua:build-fast-path -- -SkipTests -CleanTarget
```

After that, both comparison runners can use the persisted binary without a
rebuild.

#### Order-balanced WinForms/WPF result

A same-machine 5-iteration matrix was run in both driver orders for both
deterministic fixtures:

| Fixture | Driver | Median total | Observe | Reobserve | get_window_state avg | Success | Semantic Type/Click |
|---|---|---:|---:|---:|---:|---:|---:|
| WinForms | official | 665.48 ms | 223.70 ms | 221.01 ms | 177.05 ms | 100% | 100% / 100% |
| WinForms | patched | 497.76 ms | 145.95 ms | 131.74 ms | 91.22 ms | 100% | 100% / 100% |
| WPF | official | 763.07 ms | 282.62 ms | 269.80 ms | 219.72 ms | 100% | 100% / 100% |
| WPF | patched | 522.14 ms | 150.36 ms | 150.64 ms | 102.63 ms | 100% | 100% / 100% |

Order-balanced reductions:

```text
WinForms get_window_state  177.05 -> 91.22 ms   (-85.83 ms, -48.5%)
WinForms median total      665.48 -> 497.76 ms  (-167.72 ms, -25.2%)

WPF get_window_state       219.72 -> 102.63 ms  (-117.09 ms, -53.3%)
WPF median total           763.07 -> 522.14 ms  (-240.93 ms, -31.6%)
```

Per-order reductions were also consistent rather than flipping with run order:

```text
WinForms forward  get_window_state -43.7%, total -22.2%
WinForms reverse  get_window_state -52.7%, total -28.0%
WPF forward       get_window_state -50.9%, total -31.2%
WPF reverse       get_window_state -55.8%, total -31.9%
```

All eight functional benchmark rows retained 100% task success, 100% semantic
Type/Click routing, and 100% foreground preservation. Cua confidence remained
0 confirmed / 12 unverifiable / 0 suspected-noop per run, so the effect
verification limitation is unchanged.

This substantially reduces the chance that the observed fast-path win is an
official-first/patched-second warm-cache artifact. It also shows that the
benefit is not specific to WinForms: WPF, whose accessibility observation is
heavier, benefits even more from avoiding the per-observation full window
enumeration.

The next compatibility gate is the read-only exact-window real-app probe
(Notepad + isolated Edge) before considering the patched Driver suitable for
broader/default use.

#### Real-app exact-window result: Notepad and Edge

The same-machine read-only compatibility probe was run in both driver orders
with 5 measured observations per app. Each observation requested the combined
screenshot + accessibility tree for an exact titled window.

| App | Driver | Order-balanced median | Order-balanced P95 | Minimum elements | Screenshots |
|---|---|---:|---:|---:|---:|
| Notepad | official | 297.04 ms | 369.16 ms | 36 | 100% |
| Notepad | patched | 204.66 ms | 225.96 ms | 38 | 100% |
| Edge | official | 128.19 ms | 146.16 ms | 18 | 100% |
| Edge | patched | 74.87 ms | 81.38 ms | 18 | 100% |

Order-balanced median reductions:

```text
Notepad 297.04 -> 204.66 ms  (-92.39 ms, -31.1%)
Edge    128.19 ->  74.87 ms  (-53.32 ms, -41.6%)
```

The improvement remained in both run orders:

```text
Notepad forward -31.6%, reverse -30.6%
Edge    forward -50.5%, reverse -31.6%
```

Every real-app row returned `status=ok`, produced non-empty screenshots, and
returned non-empty accessibility element sets. Edge remained stable at 18
elements across all four rows; Notepad returned 36-42 elements depending on
the run.

Together with the functional WinForms/WPF matrix, this covers four materially
different Windows UI surfaces:

- WinForms;
- WPF;
- Windows 11 Notepad;
- Chromium/Edge.

No compatibility regression has been observed in these tested surfaces. The
next risk-focused validation should target window identity rather than another
framework: multi-window same-process selection, stale HWND handling, wrong-PID
diagnostics, minimized/background windows, and the fallback path when the exact
native probe cannot represent a surface.

### Window-identity regression gate

After the functional and real-app latency wins, the remaining high-risk area is
window identity rather than UI-framework coverage. Run:

```powershell
npm run benchmark:cua-window-identity-fast-path
```

The benchmark launches one WinForms process with two distinct top-level
windows and compares the installed and patched Drivers against the same
identity contract. It checks:

- same-process multi-window resolution maps each title to the fixture's exact
  HWND;
- combined screenshot + accessibility observation returns the matching window
  title for both windows;
- a non-foreground sibling window remains observable;
- a minimized sibling window is probed and reported separately;
- supplying the live HWND with the wrong PID is rejected with the ownership
  diagnostic;
- after closing one sibling, the stale HWND is rejected rather than resolving
  to the remaining same-process window.

The minimized case is intentionally reported separately from the core pass so
the benchmark can distinguish a pre-existing Driver limitation from a
fast-path regression. The core official/patched parity line covers exact
identity, titles, background observation, wrong-PID rejection, and stale-HWND
rejection.

The benchmark-only adapter helpers call `get_window_state` with an explicit
`(pid, window_id)`; production targeting behavior is unchanged.

#### Window-identity result

The official and patched Drivers were compared against the same-process
two-window identity fixture.

```text
Driver    Status  Identity  Titles  Background  Minimized  Wrong PID  Stale HWND
official  ok      true      true    true        false      true       true
patched   ok      true      true    true        false      true       true
```

Both Drivers:

- resolved the fixture's exact HWNDs;
- returned the matching titles;
- observed a non-foreground sibling window;
- rejected a live HWND paired with the wrong PID and preserved the ownership
  diagnostic;
- rejected a closed/stale HWND rather than resolving it to the remaining
  same-process window.

Both Drivers failed the minimized-window observation in the same way, so this
is treated as an existing Driver limitation rather than a fast-path regression.

The wrong-PID/stale-HWND run also exposed an adapter diagnostic bug:
chatgpt2codex previously discarded Cua's MCP `content[].text` error message and
kept only the structured refusal envelope. The adapter now preserves both, with
unit coverage.

### Opt-in runtime selection

The validated fast-path Driver can now be installed into chatgpt2codex's
persistent user state without replacing the system Cua installation:

```powershell
npm run cua:install-fast-path
```

Default install location on Windows:

```text
~\.local\share\chatgpt2codex\cua-driver\fast-path\cua-driver.exe
```

Runtime selection is explicit and fail-closed:

```powershell
$env:CHATGPT2CODEX_WINDOWS_BACKEND = "cua"
$env:CHATGPT2CODEX_CUA_DRIVER_VARIANT = "fast-path"
```

Selection precedence:

1. `CUA_DRIVER_BIN` explicit path;
2. `CHATGPT2CODEX_CUA_DRIVER_VARIANT=fast-path` persisted binary;
3. system `cua-driver` when the variant is unset or `system`.

If `fast-path` is selected but the persisted binary is missing,
chatgpt2codex reports an error instead of silently falling back to the system
Driver.

Rollback requires no reinstall:

```powershell
$env:CHATGPT2CODEX_CUA_DRIVER_VARIANT = "system"
```

The existing system Driver remains the default. This makes the optimized Driver
usable in normal chatgpt2codex runs while preserving an immediate rollback path
until the exact-window optimization is available in an official upstream Cua
release.

#### Persistent fast-path runtime smoke test

After installing the validated binary with `npm run cua:install-fast-path` and
selecting it through:

```powershell
$env:CHATGPT2CODEX_WINDOWS_BACKEND = "cua"
$env:CHATGPT2CODEX_CUA_DRIVER_VARIANT = "fast-path"
```

the normal production benchmark path (without `CUA_DRIVER_BIN`) completed
successfully:

| Metric | Result |
|---|---:|
| Functional success | 100% |
| Type applied | 100% |
| Submit applied | 100% |
| Semantic Type / Click | 100% / 100% |
| Type / Click foreground preserved | 100% / 100% |
| Median total | 423.01 ms |
| P95 total | 443.22 ms |
| Observe | 106.79 ms |
| Reobserve | 111.39 ms |
| Type | 8.53 ms |
| Click | 7.93 ms |
| get_window_state average | 65.25 ms |
| set_value average | 5.95 ms |
| click average | 5.74 ms |

Cua adapter diagnostics remained clean for the optimized path:
`list_windows=n/a`, `target-resolve=0`, target-cache 12/0 hits/misses, and
12 semantic snapshot-cache hits. The Driver confidence contract is unchanged at
0 confirmed / 12 unverifiable / 0 suspected-noop while the external fixture
verified all effects.

This validates the full runtime chain:

```text
chatgpt2codex
  -> CHATGPT2CODEX_WINDOWS_BACKEND=cua
  -> CHATGPT2CODEX_CUA_DRIVER_VARIANT=fast-path
  -> persisted user-state cua-driver.exe
  -> normal computer-use benchmark
```

At this point the benchmark/compatibility phase is complete for the tested
scope. The remaining product work is exposing the backend/runtime choice in the
Windows settings UI while keeping the system Driver and legacy backend as
immediate rollback options.

