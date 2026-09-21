param(
  [ValidateRange(1, 100)]
  [int]$Iterations = 5,
  [switch]$SkipBuild,
  [switch]$SkipTests,
  [switch]$ObservationProbe
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BuildScript = Join-Path $PSScriptRoot "build-cua-driver-fast-path.ps1"
$OutputRoot = Join-Path $ProjectRoot ".chatgpt2codex\benchmarks\cua-driver-fast-path"
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

if ($SkipBuild) {
  $PatchedBinary = Join-Path $ProjectRoot ".chatgpt2codex\cua-driver-fast-path\cua\libs\cua-driver\rust\target\release\cua-driver.exe"
} else {
  $buildArgs = @{}
  if ($SkipTests) { $buildArgs.SkipTests = $true }
  $PatchedBinary = (& $BuildScript @buildArgs | Select-Object -Last 1)
}

if (-not $PatchedBinary -or -not (Test-Path $PatchedBinary -PathType Leaf)) {
  throw "Patched cua-driver binary not found: $PatchedBinary"
}

$OfficialCommand = Get-Command cua-driver -ErrorAction Stop
$OfficialBinary = $OfficialCommand.Source
if ([string]::IsNullOrWhiteSpace($OfficialBinary)) {
  throw "Could not resolve installed cua-driver binary"
}

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$OfficialJson = Join-Path $OutputRoot "$Stamp-official.json"
$PatchedJson = Join-Path $OutputRoot "$Stamp-patched.json"
$ProbeArgs = @()
if ($ObservationProbe) { $ProbeArgs += "--cua-observe-probe" }

function Invoke-CuaBenchmark(
  [string]$Label,
  [string]$DriverBinary,
  [string]$OutputPath
) {
  Write-Host ""
  Write-Host "=== $Label ==="
  Write-Host "Driver: $DriverBinary"
  $env:CUA_DRIVER_BIN = $DriverBinary
  Push-Location $ProjectRoot
  try {
    & npm run benchmark:computer-use -- --backends cua --iterations $Iterations @ProbeArgs --output $OutputPath
    if ($LASTEXITCODE -ne 0) {
      throw "$Label benchmark failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Read-CuaSummary([string]$Label, [string]$Path) {
  $report = Get-Content $Path -Raw | ConvertFrom-Json
  $row = @($report.results | Where-Object { $_.backend -eq "cua-overlay-off" }) | Select-Object -First 1
  if (-not $row -or $row.status -ne "ok") {
    throw "$Label result is missing or unavailable in $Path"
  }

  $getWindowState = $null
  if ($row.diagnostics -and $row.diagnostics.toolTimings) {
    $prop = $row.diagnostics.toolTimings.PSObject.Properties["get_window_state"]
    if ($prop) { $getWindowState = $prop.Value }
  }
  $gwsAvg = if ($getWindowState -and [int]$getWindowState.calls -gt 0) {
    [Math]::Round([double]$getWindowState.totalMs / [int]$getWindowState.calls, 2)
  } else { 0 }

  [PSCustomObject]@{
    Driver = $Label
    MedianTotalMs = [double]$row.summary.medianTotalMs
    P95TotalMs = [double]$row.summary.p95TotalMs
    ObserveMs = [double]$row.summary.medianObserveMs
    TypeMs = [double]$row.summary.medianTypeMs
    ReobserveMs = [double]$row.summary.medianReobserveMs
    ClickMs = [double]$row.summary.medianClickMs
    GetWindowStateAvgMs = $gwsAvg
    SuccessPct = [double]$row.summary.successRate
    SemanticTypePct = [double]$row.summary.semanticTypeRate
    SemanticClickPct = [double]$row.summary.semanticClickRate
    Json = $Path
  }
}

$PriorDriver = $env:CUA_DRIVER_BIN
try {
  Invoke-CuaBenchmark "official" $OfficialBinary $OfficialJson
  Invoke-CuaBenchmark "patched" $PatchedBinary $PatchedJson
} finally {
  $env:CUA_DRIVER_BIN = $PriorDriver
}

$Official = Read-CuaSummary "official" $OfficialJson
$Patched = Read-CuaSummary "patched" $PatchedJson
$Rows = @($Official, $Patched)

Write-Host ""
Write-Host "=== Cua Driver exact-window fast-path A/B ==="
$Rows | Format-Table Driver, MedianTotalMs, P95TotalMs, ObserveMs, ReobserveMs, TypeMs, ClickMs, GetWindowStateAvgMs, SuccessPct, SemanticTypePct, SemanticClickPct -AutoSize

$DeltaGws = [Math]::Round($Patched.GetWindowStateAvgMs - $Official.GetWindowStateAvgMs, 2)
$DeltaTotal = [Math]::Round($Patched.MedianTotalMs - $Official.MedianTotalMs, 2)
$GwsReduction = if ($Official.GetWindowStateAvgMs -gt 0) {
  [Math]::Round((1 - ($Patched.GetWindowStateAvgMs / $Official.GetWindowStateAvgMs)) * 100, 1)
} else { 0 }
$TotalReduction = if ($Official.MedianTotalMs -gt 0) {
  [Math]::Round((1 - ($Patched.MedianTotalMs / $Official.MedianTotalMs)) * 100, 1)
} else { 0 }

Write-Host ""
Write-Host "get_window_state delta: $DeltaGws ms ($GwsReduction% reduction)"
Write-Host "median total delta:      $DeltaTotal ms ($TotalReduction% reduction)"
Write-Host "Official JSON: $OfficialJson"
Write-Host "Patched JSON:  $PatchedJson"
