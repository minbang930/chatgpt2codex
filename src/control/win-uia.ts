import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DomainError, ErrorCode } from "../types.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import type { ResolvedTargetPreview } from "./queue.js";

export interface WindowsUiaSelector {
  role: string;
  title?: string;
  /** Opaque observation-scoped token. The existing semantic `ax` wire shape
   * carries it so the public computer_request_action schema does not need a
   * second Windows-only target contract. */
  label: string;
}

export interface WindowsUiaElement {
  elementId: string;
  role: string;
  name?: string;
  automationId?: string;
  className?: string;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  password: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  actions: Array<"invoke" | "setValue" | "focus" | "select">;
  /** Pass this object unchanged as computer_request_action.target.ax. */
  selector: WindowsUiaSelector;
}

export interface WindowsUiaObservation {
  observationId: string;
  appName: string;
  windowTitle?: string;
  createdAt: number;
  expiresAt: number;
  truncated: boolean;
  elements: WindowsUiaElement[];
}

interface HelperElement {
  elementId?: string;
  role?: string;
  name?: string;
  automationId?: string;
  className?: string;
  enabled?: boolean;
  focusable?: boolean;
  focused?: boolean;
  password?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  actions?: string[];
}

interface HelperObservation {
  observationId?: string;
  appName?: string;
  windowTitle?: string;
  createdAt?: number;
  expiresAt?: number;
  truncated?: boolean;
  elements?: HelperElement[];
}

interface HelperRequest {
  id: number;
  op: "snapshot" | "resolve" | "press" | "setValue";
  appName: string;
  observationId?: string;
  elementId?: string;
  expectedRole?: string;
  text?: string;
  maxElements?: number;
  maxDepth?: number;
}

interface HelperResponse {
  id: number;
  ok: boolean;
  ready?: boolean;
  error?: string;
  observation?: HelperObservation;
  element?: HelperElement;
  action?: string;
}

interface PendingRequest {
  resolve: (value: HelperResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const STARTUP_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 15_000;
const MAX_STDERR = 8_000;
const MAX_ELEMENTS = 120;
const MAX_DEPTH = 10;
const OBSERVATION_ID_RE = /^uiaobs_[0-9a-f]{32}$/i;
const ELEMENT_ID_RE = /^uiael_[1-9][0-9]*$/i;
const UIA_LABEL_RE = /^uiaref:(uiaobs_[0-9a-f]{32}):(uiael_[1-9][0-9]*)$/i;

const WINDOWS_UIA_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class ChatGpt2CodexWinUiaWindow {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    const int SW_RESTORE = 9;

    static Process WindowProcess(IntPtr hWnd) {
        uint pid; GetWindowThreadProcessId(hWnd, out pid);
        if (pid == 0) return null;
        try { return Process.GetProcessById((int)pid); } catch { return null; }
    }
    static string ProcessName(Process process) {
        if (process == null) return null;
        try { return process.ProcessName; } catch { return null; }
    }
    static string Description(Process process) {
        if (process == null) return null;
        try {
            var description = process.MainModule.FileVersionInfo.FileDescription;
            if (!String.IsNullOrWhiteSpace(description)) return description.Trim();
            var product = process.MainModule.FileVersionInfo.ProductName;
            if (!String.IsNullOrWhiteSpace(product)) return product.Trim();
        } catch { }
        return ProcessName(process);
    }
    static bool Match(Process process, string requested) {
        if (process == null || String.IsNullOrWhiteSpace(requested)) return false;
        var needle = requested.Trim();
        if (needle.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) needle = needle.Substring(0, needle.Length - 4);
        if (String.Equals(ProcessName(process), needle, StringComparison.OrdinalIgnoreCase)) return true;
        var description = Description(process);
        return !String.IsNullOrWhiteSpace(description) && String.Equals(description, requested.Trim(), StringComparison.OrdinalIgnoreCase);
    }
    public static IntPtr FindWindow(string appName) {
        var foreground = GetForegroundWindow();
        if (foreground != IntPtr.Zero && IsWindowVisible(foreground) && !IsIconic(foreground) && Match(WindowProcess(foreground), appName)) return foreground;
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
            if (Match(WindowProcess(hWnd), appName)) { found = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static IntPtr Activate(string appName) {
        var hWnd = FindWindow(appName);
        if (hWnd == IntPtr.Zero) throw new InvalidOperationException("target app window not found");
        if (GetForegroundWindow() == hWnd) return hWnd;
        ShowWindowAsync(hWnd, SW_RESTORE);
        if (!SetForegroundWindow(hWnd)) throw new InvalidOperationException("Windows refused to activate the target app window");
        System.Threading.Thread.Sleep(75);
        if (GetForegroundWindow() != hWnd) throw new InvalidOperationException("target app did not become foreground; UIA action refused");
        return hWnd;
    }
}
'@

$script:UiaObservations = @{}
$script:UiaObservationOrder = New-Object System.Collections.ArrayList
$UIA_TTL_MS = 120000
$UIA_CACHE_LIMIT = 8
$UIA_MAX_VISITED = 800

function Now-Ms { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Short-Text($value, [int]$limit) {
  if ($null -eq $value) { return $null }
  $text = ([string]$value).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  if ($text.Length -gt $limit) { return $text.Substring(0, $limit) }
  return $text
}

function Remove-ExpiredObservations {
  $now = Now-Ms
  foreach ($id in @($script:UiaObservations.Keys)) {
    $obs = $script:UiaObservations[$id]
    if ($null -eq $obs -or [int64]$obs.expiresAt -le $now) {
      $script:UiaObservations.Remove($id)
      [void]$script:UiaObservationOrder.Remove($id)
    }
  }
  while ($script:UiaObservationOrder.Count -gt $UIA_CACHE_LIMIT) {
    $oldest = [string]$script:UiaObservationOrder[0]
    $script:UiaObservationOrder.RemoveAt(0)
    $script:UiaObservations.Remove($oldest)
  }
}

function Get-Role($element) {
  try {
    $name = [string]$element.Current.ControlType.ProgrammaticName
    if ($name.StartsWith('ControlType.')) { $name = $name.Substring(12) }
    $name = ($name -replace '[^A-Za-z ]', ' ').Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { return 'Custom' }
    if ($name.Length -gt 40) { return $name.Substring(0, 40) }
    return $name
  } catch { return 'Custom' }
}

function Get-Bounds($element) {
  try {
    $r = $element.Current.BoundingRectangle
    if ([double]::IsNaN($r.X) -or [double]::IsNaN($r.Y) -or [double]::IsNaN($r.Width) -or [double]::IsNaN($r.Height)) { return $null }
    if ([double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Y) -or [double]::IsInfinity($r.Width) -or [double]::IsInfinity($r.Height)) { return $null }
    if ($r.Width -le 0 -or $r.Height -le 0) { return $null }
    return @{ x=[int][Math]::Round($r.X); y=[int][Math]::Round($r.Y); width=[int][Math]::Round($r.Width); height=[int][Math]::Round($r.Height) }
  } catch { return $null }
}

function Try-Pattern($element, $pattern) {
  $value = $null
  try {
    if ($element.TryGetCurrentPattern($pattern, [ref]$value)) { return $value }
  } catch { }
  return $null
}

function Describe-Element($element, [string]$elementId) {
  try { $current = $element.Current } catch { return $null }
  try { if ($current.IsOffscreen) { return $null } } catch { }

  $role = Get-Role $element
  $name = Short-Text $current.Name 160
  $automationId = Short-Text $current.AutomationId 120
  $className = Short-Text $current.ClassName 80
  $bounds = Get-Bounds $element
  $actions = New-Object System.Collections.ArrayList

  $invoke = Try-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
  if ($null -ne $invoke) { [void]$actions.Add('invoke') }

  $valuePattern = Try-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -ne $valuePattern) {
    try { if (-not $valuePattern.Current.IsReadOnly) { [void]$actions.Add('setValue') } } catch { }
  }

  $selectionItem = Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($null -ne $selectionItem) { [void]$actions.Add('select') }

  $focusable = $false
  $focused = $false
  $enabled = $false
  $password = $false
  $processId = 0
  $controlTypeId = 0
  try { $focusable = [bool]$current.IsKeyboardFocusable } catch { }
  try { $focused = [bool]$current.HasKeyboardFocus } catch { }
  try { $enabled = [bool]$current.IsEnabled } catch { }
  try { $password = [bool]$current.IsPassword } catch { }
  try { $processId = [int]$current.ProcessId } catch { }
  try { $controlTypeId = [int]$current.ControlType.Id } catch { }
  if ($focusable) { [void]$actions.Add('focus') }

  if ($actions.Count -eq 0 -and $null -eq $name -and $null -eq $automationId) { return $null }

  return [pscustomobject]@{
    public = [ordered]@{
      elementId = $elementId
      role = $role
      name = $name
      automationId = $automationId
      className = $className
      enabled = $enabled
      focusable = $focusable
      focused = $focused
      password = $password
      x = if ($null -ne $bounds) { $bounds.x } else { $null }
      y = if ($null -ne $bounds) { $bounds.y } else { $null }
      width = if ($null -ne $bounds) { $bounds.width } else { $null }
      height = if ($null -ne $bounds) { $bounds.height } else { $null }
      actions = @($actions)
    }
    cached = [pscustomobject]@{
      elementId = $elementId
      role = $role
      name = $name
      automationId = $automationId
      className = $className
      processId = $processId
      controlTypeId = $controlTypeId
      bounds = $bounds
    }
  }
}

function Get-UiaSnapshot([string]$appName, [int]$maxElements, [int]$maxDepth) {
  Remove-ExpiredObservations
  if ([string]::IsNullOrWhiteSpace($appName)) { throw 'appName is required' }
  $maxElements = [Math]::Min(120, [Math]::Max(1, $maxElements))
  $maxDepth = [Math]::Min(10, [Math]::Max(1, $maxDepth))

  $hWnd = [ChatGpt2CodexWinUiaWindow]::FindWindow($appName)
  if ($hWnd -eq [IntPtr]::Zero) { throw 'target app window not found' }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)
  if ($null -eq $root) { throw 'UI Automation could not resolve the target window' }

  try { $processId = [int]$root.Current.ProcessId } catch { throw 'UI Automation could not read the target process' }
  $windowTitle = $null
  try { $windowTitle = Short-Text $root.Current.Name 160 } catch { }

  $publicElements = New-Object System.Collections.ArrayList
  $cachedElements = @{}
  $queue = New-Object System.Collections.Queue
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $visited = 0

  try { $child = $walker.GetFirstChild($root) } catch { $child = $null }
  while ($null -ne $child) {
    $queue.Enqueue([pscustomobject]@{ element=$child; depth=1 })
    try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
  }

  while ($queue.Count -gt 0 -and $publicElements.Count -lt $maxElements -and $visited -lt $UIA_MAX_VISITED) {
    $item = $queue.Dequeue()
    $visited++
    $element = $item.element
    $depth = [int]$item.depth

    $elementId = 'uiael_' + ($publicElements.Count + 1)
    $described = Describe-Element $element $elementId
    if ($null -ne $described) {
      [void]$publicElements.Add($described.public)
      $cachedElements[$elementId] = $described.cached
    }

    if ($depth -lt $maxDepth) {
      try { $child = $walker.GetFirstChild($element) } catch { $child = $null }
      while ($null -ne $child) {
        $queue.Enqueue([pscustomobject]@{ element=$child; depth=($depth + 1) })
        try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
      }
    }
  }

  $now = Now-Ms
  $observationId = 'uiaobs_' + [Guid]::NewGuid().ToString('N')
  $expiresAt = $now + $UIA_TTL_MS
  $observation = [pscustomobject]@{
    observationId = $observationId
    appName = $appName
    processId = $processId
    windowTitle = $windowTitle
    createdAt = $now
    expiresAt = $expiresAt
    elements = $cachedElements
  }
  $script:UiaObservations[$observationId] = $observation
  [void]$script:UiaObservationOrder.Add($observationId)
  Remove-ExpiredObservations

  return [ordered]@{
    observationId = $observationId
    appName = $appName
    windowTitle = $windowTitle
    createdAt = $now
    expiresAt = $expiresAt
    truncated = ($queue.Count -gt 0 -or $visited -ge $UIA_MAX_VISITED)
    elements = @($publicElements)
  }
}

function Resolve-CachedElement([string]$appName, [string]$observationId, [string]$elementId, [bool]$activate) {
  Remove-ExpiredObservations
  $obs = $script:UiaObservations[$observationId]
  if ($null -eq $obs) { throw 'UIA observation expired or is unknown; capture a fresh screenshot' }
  if (-not [string]::Equals([string]$obs.appName, $appName, [StringComparison]::OrdinalIgnoreCase)) { throw 'UIA observation belongs to a different app' }
  $descriptor = $obs.elements[$elementId]
  if ($null -eq $descriptor) { throw 'UIA element id is not part of this observation' }

  $hWnd = if ($activate) { [ChatGpt2CodexWinUiaWindow]::Activate($appName) } else { [ChatGpt2CodexWinUiaWindow]::FindWindow($appName) }
  if ($hWnd -eq [IntPtr]::Zero) { throw 'target app window not found' }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)
  if ($null -eq $root) { throw 'UI Automation could not resolve the current target window' }
  try {
    if ([int]$root.Current.ProcessId -ne [int]$obs.processId) { throw 'UIA observation is stale because the target process changed' }
  } catch { throw 'UIA observation is stale because the target process changed' }

  $condition = $null
  if (-not [string]::IsNullOrWhiteSpace([string]$descriptor.automationId)) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$descriptor.automationId)
  } elseif (-not [string]::IsNullOrWhiteSpace([string]$descriptor.name)) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, [string]$descriptor.name)
  } else {
    throw 'UIA element has no stable selector; use the coordinate fallback from the screenshot'
  }

  $matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $best = $null
  $bestScore = [double]::PositiveInfinity
  $limit = [Math]::Min(64, $matches.Count)
  for ($i = 0; $i -lt $limit; $i++) {
    $candidate = $matches.Item($i)
    try { $current = $candidate.Current } catch { continue }
    try { if ([int]$current.ProcessId -ne [int]$obs.processId) { continue } } catch { continue }
    try { if ([int]$current.ControlType.Id -ne [int]$descriptor.controlTypeId) { continue } } catch { continue }
    if (-not [string]::IsNullOrWhiteSpace([string]$descriptor.className)) {
      try { if (-not [string]::Equals([string]$current.ClassName, [string]$descriptor.className, [StringComparison]::Ordinal)) { continue } } catch { continue }
    }

    $score = 0.0
    if ($null -ne $descriptor.bounds) {
      $bounds = Get-Bounds $candidate
      if ($null -ne $bounds) {
        $oldX = [double]$descriptor.bounds.x + ([double]$descriptor.bounds.width / 2.0)
        $oldY = [double]$descriptor.bounds.y + ([double]$descriptor.bounds.height / 2.0)
        $newX = [double]$bounds.x + ([double]$bounds.width / 2.0)
        $newY = [double]$bounds.y + ([double]$bounds.height / 2.0)
        $score = [Math]::Abs($oldX - $newX) + [Math]::Abs($oldY - $newY)
      }
    }
    if ($score -lt $bestScore) { $best = $candidate; $bestScore = $score }
  }
  if ($null -eq $best) { throw 'UIA element is stale or no longer matches; capture a fresh screenshot' }
  return [pscustomobject]@{ element=$best; descriptor=$descriptor }
}

function Resolve-PublicElement([string]$appName, [string]$observationId, [string]$elementId) {
  $resolved = Resolve-CachedElement $appName $observationId $elementId $false
  $described = Describe-Element $resolved.element $elementId
  if ($null -eq $described) { throw 'UIA element is no longer observable' }
  return $described.public
}

function Press-UiaElement([string]$appName, [string]$observationId, [string]$elementId) {
  $resolved = Resolve-CachedElement $appName $observationId $elementId $true
  $element = $resolved.element
  $invoke = Try-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
  if ($null -ne $invoke) { $invoke.Invoke(); return 'invoke' }
  $selection = Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($null -ne $selection) { $selection.Select(); return 'select' }
  try {
    if ($element.Current.IsKeyboardFocusable) { $element.SetFocus(); return 'focus' }
  } catch { }
  throw 'UIA element has no reliable invoke/select/focus action; use coordinate fallback'
}

function Set-UiaValue([string]$appName, [string]$observationId, [string]$elementId, [string]$text) {
  $resolved = Resolve-CachedElement $appName $observationId $elementId $true
  $element = $resolved.element
  try { if ($element.Current.IsKeyboardFocusable) { $element.SetFocus() } } catch { }
  $valuePattern = Try-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -eq $valuePattern) { throw 'UIA element does not expose ValuePattern; use coordinate typing fallback' }
  try { if ($valuePattern.Current.IsReadOnly) { throw 'UIA value target is read-only' } } catch { throw 'UIA value target is read-only' }
  $valuePattern.SetValue($text)
  return 'setValue'
}

[Console]::Out.WriteLine((@{ id=0; ok=$true; ready=$true } | ConvertTo-Json -Compress))
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = 0
  try {
    $payload = $line | ConvertFrom-Json
    $id = [int]$payload.id
    switch ([string]$payload.op) {
      'snapshot' {
        $snapshot = Get-UiaSnapshot ([string]$payload.appName) ([int]$payload.maxElements) ([int]$payload.maxDepth)
        $result = @{ id=$id; ok=$true; observation=$snapshot }
      }
      'resolve' {
        $element = Resolve-PublicElement ([string]$payload.appName) ([string]$payload.observationId) ([string]$payload.elementId)
        $result = @{ id=$id; ok=$true; element=$element }
      }
      'press' {
        $action = Press-UiaElement ([string]$payload.appName) ([string]$payload.observationId) ([string]$payload.elementId)
        $result = @{ id=$id; ok=$true; action=$action }
      }
      'setValue' {
        $action = Set-UiaValue ([string]$payload.appName) ([string]$payload.observationId) ([string]$payload.elementId) ([string]$payload.text)
        $result = @{ id=$id; ok=$true; action=$action }
      }
      default { throw 'unsupported Windows UIA operation' }
    }
  } catch {
    $result = @{ id=$id; ok=$false; error=$_.Exception.Message }
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}
`;

let helper: ChildProcessWithoutNullStreams | undefined;
let helperStart: Promise<ChildProcessWithoutNullStreams> | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();
let stderrTail = "";

function assertWin32(): void {
  if (process.platform !== "win32") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Windows UI Automation is only supported on Windows");
  }
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function helperScriptPath(): Promise<string> {
  const digest = createHash("sha256").update(WINDOWS_UIA_HELPER_SCRIPT).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "chatgpt2codex");
  const file = path.join(dir, `win-uia-${digest}.ps1`);
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.readFile(file, "utf8").catch(() => undefined);
  if (existing !== WINDOWS_UIA_HELPER_SCRIPT) await fs.writeFile(file, WINDOWS_UIA_HELPER_SCRIPT, "utf8");
  return file;
}

function failPending(error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

async function startHelper(): Promise<ChildProcessWithoutNullStreams> {
  assertWin32();
  if (helper && !helper.killed && helper.exitCode === null) return helper;
  if (helperStart) return helperStart;
  helperStart = (async () => {
    const script = await helperScriptPath();
    const child = spawn(
      powershellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { env: buildSafeChildEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    stderrTail = "";
    child.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-MAX_STDERR);
    });

    let readySettled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const readyTimer = setTimeout(() => {
      if (readySettled) return;
      readySettled = true;
      rejectReady(new Error(`Windows UIA helper startup timed out: ${stderrTail.trim() || "no stderr"}`));
      child.kill();
    }, STARTUP_TIMEOUT_MS);

    const settleReadyFailure = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
      rejectReady(error);
    };

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let response: HelperResponse;
      try { response = JSON.parse(line) as HelperResponse; } catch { return; }
      if (response.id === 0 && response.ok && response.ready) {
        if (!readySettled) {
          readySettled = true;
          clearTimeout(readyTimer);
          resolveReady();
        }
        return;
      }
      if (!Number.isInteger(response.id)) return;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.ok) request.resolve(response);
      else request.reject(new Error(response.error || "Windows UIA helper failed"));
    });
    child.once("error", (error) => {
      if (helper === child) helper = undefined;
      settleReadyFailure(error);
      failPending(error);
    });
    child.once("exit", (code) => {
      if (helper === child) helper = undefined;
      const error = new Error(`Windows UIA helper exited ${code ?? "unknown"}: ${stderrTail.trim() || "no stderr"}`);
      settleReadyFailure(error);
      failPending(error);
    });
    helper = child;
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stderr as unknown as { unref?: () => void }).unref?.();

    try {
      await readyPromise;
      return child;
    } catch (error) {
      if (helper === child) helper = undefined;
      if (child.exitCode === null && !child.killed) child.kill();
      throw error;
    }
  })();
  try {
    return await helperStart;
  } finally {
    helperStart = undefined;
  }
}

async function requestHelper(payload: Omit<HelperRequest, "id">): Promise<HelperResponse> {
  const child = await startHelper();
  const id = nextRequestId++;
  const timeoutMs = payload.op === "snapshot" ? SNAPSHOT_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Windows UIA helper request timed out (${payload.op})`));
      if (helper === child) helper = undefined;
      if (child.exitCode === null && !child.killed) child.kill();
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
      if (!error) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      reject(error);
    });
  });
}

function normalizeBounds(element: HelperElement): WindowsUiaElement["bounds"] {
  const values = [element.x, element.y, element.width, element.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
  if ((element.width as number) <= 0 || (element.height as number) <= 0) return undefined;
  return {
    x: Math.round(element.x as number),
    y: Math.round(element.y as number),
    width: Math.round(element.width as number),
    height: Math.round(element.height as number),
  };
}

function normalizeActions(actions: unknown): WindowsUiaElement["actions"] {
  if (!Array.isArray(actions)) return [];
  const allowed = new Set(["invoke", "setValue", "focus", "select"]);
  return Array.from(new Set(actions.filter((value): value is WindowsUiaElement["actions"][number] => typeof value === "string" && allowed.has(value))));
}

function labelFor(observationId: string, elementId: string): string {
  return `uiaref:${observationId}:${elementId}`;
}

function normalizeElement(observationId: string, raw: HelperElement): WindowsUiaElement | undefined {
  const elementId = raw.elementId?.trim();
  let role = raw.role?.trim();
  if (!elementId || !ELEMENT_ID_RE.test(elementId) || !role) return undefined;
  role = role.replace(/[^A-Za-z ]/g, " ").trim().slice(0, 40) || "Custom";
  const name = raw.name?.trim() || undefined;
  const automationId = raw.automationId?.trim() || undefined;
  const className = raw.className?.trim() || undefined;
  const selector: WindowsUiaSelector = {
    role,
    ...(name ? { title: name } : {}),
    label: labelFor(observationId, elementId),
  };
  return {
    elementId,
    role,
    name,
    automationId,
    className,
    enabled: raw.enabled === true,
    focusable: raw.focusable === true,
    focused: raw.focused === true,
    password: raw.password === true,
    bounds: normalizeBounds(raw),
    actions: normalizeActions(raw.actions),
    selector,
  };
}

function normalizeObservation(raw: HelperObservation | undefined): WindowsUiaObservation {
  const observationId = raw?.observationId?.trim();
  const appName = raw?.appName?.trim();
  const createdAt = raw?.createdAt;
  const expiresAt = raw?.expiresAt;
  if (!observationId || !OBSERVATION_ID_RE.test(observationId) || !appName) {
    throw new Error("Windows UIA helper returned an invalid observation identity");
  }
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new Error("Windows UIA helper returned invalid observation timestamps");
  }
  const elements = (Array.isArray(raw?.elements) ? raw.elements : [])
    .slice(0, MAX_ELEMENTS)
    .map((element) => normalizeElement(observationId, element))
    .filter((element): element is WindowsUiaElement => element !== undefined);
  return {
    observationId,
    appName,
    windowTitle: raw?.windowTitle?.trim() || undefined,
    createdAt,
    expiresAt,
    truncated: raw?.truncated === true,
    elements,
  };
}

export function parseUiaSemanticTarget(target: { role: string; label?: string }): { observationId: string; elementId: string; role: string } | undefined {
  const match = target.label?.match(UIA_LABEL_RE);
  if (!match) return undefined;
  const observationId = match[1];
  const elementId = match[2];
  if (!observationId || !elementId) return undefined;
  return { observationId, elementId, role: target.role };
}

function requireUiaTarget(target: { role: string; label?: string }): { observationId: string; elementId: string; role: string } {
  const parsed = parseUiaSemanticTarget(target);
  if (!parsed) {
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      "Windows semantic target is not a current UIA reference; capture a fresh app screenshot and use an element.selector as target.ax",
    );
  }
  return parsed;
}

export async function snapshotSemanticElements(appName: string, options: { maxElements?: number; maxDepth?: number } = {}): Promise<WindowsUiaObservation> {
  assertWin32();
  const maxElements = Math.min(MAX_ELEMENTS, Math.max(1, Math.round(options.maxElements ?? MAX_ELEMENTS)));
  const maxDepth = Math.min(MAX_DEPTH, Math.max(1, Math.round(options.maxDepth ?? 8)));
  const result = await requestHelper({ op: "snapshot", appName, maxElements, maxDepth });
  return normalizeObservation(result.observation);
}

function previewFromElement(appName: string, raw: HelperElement, expectedRole: string): ResolvedTargetPreview {
  const role = raw.role?.trim() || expectedRole;
  return {
    found: true,
    role,
    title: raw.name?.trim() || undefined,
    description: raw.automationId?.trim() || raw.className?.trim() || undefined,
    frame: normalizeBounds(raw),
    app: appName,
    matchCount: 1,
    actions: normalizeActions(raw.actions),
  };
}

export async function resolveSemanticElement(appName: string, target: { role: string; label?: string }): Promise<ResolvedTargetPreview> {
  assertWin32();
  const ref = requireUiaTarget(target);
  try {
    const result = await requestHelper({
      op: "resolve",
      appName,
      observationId: ref.observationId,
      elementId: ref.elementId,
      expectedRole: ref.role,
    });
    if (!result.element) return { found: false, reason: "Windows UIA helper returned no element" };
    const actualRole = result.element.role?.trim();
    if (actualRole && actualRole.toLowerCase() !== ref.role.trim().toLowerCase()) {
      return { found: false, reason: "UIA element role changed; capture a fresh screenshot" };
    }
    return previewFromElement(appName, result.element, ref.role);
  } catch (error) {
    return { found: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function pressSemanticElement(appName: string, target: { role: string; label?: string }): Promise<void> {
  assertWin32();
  const ref = requireUiaTarget(target);
  await requestHelper({
    op: "press",
    appName,
    observationId: ref.observationId,
    elementId: ref.elementId,
    expectedRole: ref.role,
  });
}

export async function setSemanticValue(appName: string, target: { role: string; label?: string }, text: string): Promise<void> {
  assertWin32();
  const ref = requireUiaTarget(target);
  await requestHelper({
    op: "setValue",
    appName,
    observationId: ref.observationId,
    elementId: ref.elementId,
    expectedRole: ref.role,
    text,
  });
}

/** Tests and shutdown paths may call this without performing any UIA action. */
export async function stopWindowsUiaHelper(): Promise<void> {
  const child = helper;
  helper = undefined;
  if (!child || child.exitCode !== null) return;
  child.stdin.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
