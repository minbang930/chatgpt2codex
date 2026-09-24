param(
  [ValidateRange(1, 100)]
  [int]$Iterations = 5,
  [switch]$SkipBuild,
  [switch]$SkipTests,
  [switch]$ObservationProbe,
  [ValidateSet("forward", "reverse", "both")]
  [string]$Order = "both",
  [ValidateSet("winforms", "wpf", "both")]
  [string]$Fixture = "both"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BuildScript = Join-Path $PSScriptRoot "build-cua-driver-fast-path.ps1"
$OutputRoot = Join-Path $ProjectRoot ".chatgpt2codex\benchmarks\cua-driver-fast-path"
$PersistedPatchedBinary = Join-Path $ProjectRoot ".chatgpt2codex\bin\cua-driver-fast-path.exe"
$TargetPatchedBinary = Join-Path $ProjectRoot ".chatgpt2codex\cua-driver-fast-path\cua\libs\cua-driver\rust\target\release\cua-driver.exe"
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

if ($SkipBuild) {
  if (Test-Path $PersistedPatchedBinary -PathType Leaf) {
    $PatchedBinary = $PersistedPatchedBinary
  } else {
    $PatchedBinary = $TargetPatchedBinary
  }
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

$ProbeArgs = @()
if ($ObservationProbe) { $ProbeArgs += "--cua-observe-probe" }

$Fixtures = if ($Fixture -eq "both") { @("winforms", "wpf") } else { @($Fixture) }
$Passes = switch ($Order) {
  "forward" {
    @([PSCustomObject]@{
      Name = "forward"
      Drivers = @(
        [PSCustomObject]@{ Label = "official"; Binary = $OfficialBinary },
        [PSCustomObject]@{ Label = "patched"; Binary = $PatchedBinary }
      )
    })
  }
  "reverse" {
    @([PSCustomObject]@{
      Name = "reverse"
      Drivers = @(
        [PSCustomObject]@{ Label = "patched"; Binary = $PatchedBinary },
        [PSCustomObject]@{ Label = "official"; Binary = $OfficialBinary }
      )
    })
  }
  default {
    @(
      [PSCustomObject]@{
        Name = "forward"
        Drivers = @(
          [PSCustomObject]@{ Label = "official"; Binary = $OfficialBinary },
          [PSCustomObject]@{ Label = "patched"; Binary = $PatchedBinary }
        )
      },
      [PSCustomObject]@{
        Name = "reverse"
        Drivers = @(
          [PSCustomObject]@{ Label = "patched"; Binary = $PatchedBinary },
          [PSCustomObject]@{ Label = "official"; Binary = $OfficialBinary }
        )
      }
    )
  }
}

function Invoke-CuaBenchmark(
  [string]$FixtureName,
  [string]$PassName,
  [string]$Label,
  [string]$DriverBinary,
  [string]$OutputPath
) {
  Write-Host ""
  Write-Host "=== $FixtureName / $PassName / $Label ==="
  Write-Host "Driver: $DriverBinary"
  $env:CUA_DRIVER_BIN = $DriverBinary
  Push-Location $ProjectRoot
  try {
    & npm run benchmark:computer-use -- --backends cua --iterations $Iterations --fixture $FixtureName @ProbeArgs --output $OutputPath
    if ($LASTEXITCODE -ne 0) {
      throw "$FixtureName/$PassName/$Label benchmark failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Read-CuaSummary(
  [string]$FixtureName,
  [string]$PassName,
  [string]$Label,
  [string]$Path
) {
  $report = Get-Content $Path -Raw | ConvertFrom-Json
  $row = @($report.results | Where-Object { $_.backend -eq "cua-overlay-off" }) | Select-Object -First 1
  if (-not $row -or $row.status -ne "ok") {
    throw "$FixtureName/$PassName/$Label result is missing or unavailable in $Path"
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
    Fixture = $FixtureName
    Pass = $PassName
    Driver = $Label
    MedianTotalMs = [double]$row.summary.medianTotalMs
    P95TotalMs = [double]$row.summary.p95TotalMs
    ObserveMs = [double]$row.summary.medianObserveMs
    ReobserveMs = [double]$row.summary.medianReobserveMs
    TypeMs = [double]$row.summary.medianTypeMs
    ClickMs = [double]$row.summary.medianClickMs
    GetWindowStateAvgMs = $gwsAvg
    SuccessPct = [double]$row.summary.successRate
    SemanticTypePct = [double]$row.summary.semanticTypeRate
    SemanticClickPct = [double]$row.summary.semanticClickRate
    TypeFgPct = $row.summary.typeForegroundPreservedRate
    ClickFgPct = $row.summary.clickForegroundPreservedRate
    Json = $Path
  }
}

function Mean([object[]]$Values) {
  $numbers = @($Values | ForEach-Object { [double]$_ })
  if ($numbers.Count -eq 0) { return 0 }
  return [Math]::Round(($numbers | Measure-Object -Average).Average, 2)
}

$PriorDriver = $env:CUA_DRIVER_BIN
$Rows = @()
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"

try {
  foreach ($fixtureName in $Fixtures) {
    foreach ($pass in $Passes) {
      foreach ($driver in $pass.Drivers) {
        $output = Join-Path $OutputRoot "$Stamp-$fixtureName-$($pass.Name)-$($driver.Label).json"
        Invoke-CuaBenchmark $fixtureName $pass.Name $driver.Label $driver.Binary $output
        $Rows += Read-CuaSummary $fixtureName $pass.Name $driver.Label $output
      }
    }
  }
} finally {
  $env:CUA_DRIVER_BIN = $PriorDriver
}

Write-Host ""
Write-Host "=== Cua Driver exact-window fast-path raw A/B ==="
$Rows |
  Select-Object Fixture, Pass, Driver, MedianTotalMs, P95TotalMs, ObserveMs, ReobserveMs, TypeMs, ClickMs, GetWindowStateAvgMs, SuccessPct, SemanticTypePct, SemanticClickPct |
  Format-Table -AutoSize

Write-Host ""
Write-Host "=== Per-order deltas (patched - official) ==="
$DeltaRows = @()
foreach ($fixtureName in $Fixtures) {
  foreach ($pass in $Passes) {
    $official = @($Rows | Where-Object { $_.Fixture -eq $fixtureName -and $_.Pass -eq $pass.Name -and $_.Driver -eq "official" }) | Select-Object -First 1
    $patched = @($Rows | Where-Object { $_.Fixture -eq $fixtureName -and $_.Pass -eq $pass.Name -and $_.Driver -eq "patched" }) | Select-Object -First 1
    if ($official -and $patched) {
      $DeltaRows += [PSCustomObject]@{
        Fixture = $fixtureName
        Pass = $pass.Name
        GetWindowStateDeltaMs = [Math]::Round($patched.GetWindowStateAvgMs - $official.GetWindowStateAvgMs, 2)
        GetWindowStateReductionPct = if ($official.GetWindowStateAvgMs -gt 0) {
          [Math]::Round((1 - ($patched.GetWindowStateAvgMs / $official.GetWindowStateAvgMs)) * 100, 1)
        } else { 0 }
        MedianTotalDeltaMs = [Math]::Round($patched.MedianTotalMs - $official.MedianTotalMs, 2)
        MedianTotalReductionPct = if ($official.MedianTotalMs -gt 0) {
          [Math]::Round((1 - ($patched.MedianTotalMs / $official.MedianTotalMs)) * 100, 1)
        } else { 0 }
      }
    }
  }
}
$DeltaRows | Format-Table -AutoSize

if ($Passes.Count -gt 1) {
  Write-Host ""
  Write-Host "=== Order-balanced means ==="
  $BalancedRows = @()
  foreach ($fixtureName in $Fixtures) {
    foreach ($driverLabel in @("official", "patched")) {
      $group = @($Rows | Where-Object { $_.Fixture -eq $fixtureName -and $_.Driver -eq $driverLabel })
      $BalancedRows += [PSCustomObject]@{
        Fixture = $fixtureName
        Driver = $driverLabel
        MedianTotalMs = Mean @($group.MedianTotalMs)
        ObserveMs = Mean @($group.ObserveMs)
        ReobserveMs = Mean @($group.ReobserveMs)
        GetWindowStateAvgMs = Mean @($group.GetWindowStateAvgMs)
        SuccessPct = Mean @($group.SuccessPct)
        SemanticTypePct = Mean @($group.SemanticTypePct)
        SemanticClickPct = Mean @($group.SemanticClickPct)
      }
    }
  }
  $BalancedRows | Format-Table -AutoSize

  Write-Host ""
  Write-Host "=== Order-balanced reductions ==="
  foreach ($fixtureName in $Fixtures) {
    $official = @($BalancedRows | Where-Object { $_.Fixture -eq $fixtureName -and $_.Driver -eq "official" }) | Select-Object -First 1
    $patched = @($BalancedRows | Where-Object { $_.Fixture -eq $fixtureName -and $_.Driver -eq "patched" }) | Select-Object -First 1
    if ($official -and $patched) {
      $gwsDelta = [Math]::Round($patched.GetWindowStateAvgMs - $official.GetWindowStateAvgMs, 2)
      $gwsReduction = if ($official.GetWindowStateAvgMs -gt 0) {
        [Math]::Round((1 - ($patched.GetWindowStateAvgMs / $official.GetWindowStateAvgMs)) * 100, 1)
      } else { 0 }
      $totalDelta = [Math]::Round($patched.MedianTotalMs - $official.MedianTotalMs, 2)
      $totalReduction = if ($official.MedianTotalMs -gt 0) {
        [Math]::Round((1 - ($patched.MedianTotalMs / $official.MedianTotalMs)) * 100, 1)
      } else { 0 }
      Write-Host "$fixtureName get_window_state: $gwsDelta ms ($gwsReduction% reduction)"
      Write-Host "$fixtureName median total:     $totalDelta ms ($totalReduction% reduction)"
    }
  }
}

Write-Host ""
Write-Host "Reports: $OutputRoot"
