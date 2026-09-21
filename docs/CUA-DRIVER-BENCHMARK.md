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

The child is launched with Cua telemetry disabled. chatgpt2codex does not bundle,
download, or silently install Cua Driver.

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

Run this from an **interactive Windows desktop**, not a headless CI runner:

```powershell
npm run benchmark:computer-use -- --iterations 20
```

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
- failures.

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
