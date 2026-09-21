param(
  [ValidateRange(1, 20)]
  [int]$Iterations = 5,
  [ValidateSet("forward", "reverse", "both")]
  [string]$Order = "both"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OutputRoot = Join-Path $ProjectRoot ".chatgpt2codex\benchmarks\cua-real-app-fast-path"
$PersistedPatchedBinary = Join-Path $ProjectRoot ".chatgpt2codex\bin\cua-driver-fast-path.exe"
$TargetPatchedBinary = Join-Path $ProjectRoot ".chatgpt2codex\cua-driver-fast-path\cua\libs\cua-driver\rust\target\release\cua-driver.exe"
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$PatchedBinary = if (Test-Path $PersistedPatchedBinary -PathType Leaf) {
  $PersistedPatchedBinary
} else {
  $TargetPatchedBinary
}
if (-not (Test-Path $PatchedBinary -PathType Leaf)) {
  throw "Patched Cua Driver not found. Run: npm run cua:build-fast-path"
}

$OfficialCommand = Get-Command cua-driver -ErrorAction Stop
$OfficialBinary = $OfficialCommand.Source

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

function Read-Utf8Json([string]$Path) {
  $text = [System.IO.File]::ReadAllText(
    $Path,
    [System.Text.Encoding]::UTF8
  )
  return ($text | ConvertFrom-Json)
}

function Get-OptionalProperty(
  [object]$Object,
  [string]$Name
) {
  if ($null -eq $Object) {
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Invoke-Compat(
  [string]$PassName,
  [string]$Label,
  [string]$Binary,
  [string]$Output
) {
  Write-Host ""
  Write-Host "=== real-app / $PassName / $Label ==="
  Write-Host "Driver: $Binary"
  $env:CUA_DRIVER_BIN = $Binary
  Push-Location $ProjectRoot
  try {
    & npm run benchmark:cua-real-app -- --iterations $Iterations --output $Output
    if ($LASTEXITCODE -ne 0) {
      throw "$PassName/$Label real-app benchmark failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$PriorDriver = $env:CUA_DRIVER_BIN
$Rows = @()

try {
  foreach ($pass in $Passes) {
    foreach ($driver in $pass.Drivers) {
      $output = Join-Path $OutputRoot "$Stamp-$($pass.Name)-$($driver.Label).json"
      Invoke-Compat $pass.Name $driver.Label $driver.Binary $output
      $report = Read-Utf8Json $output
      foreach ($result in $report.results) {
        $medianMs = Get-OptionalProperty $result "medianMs"
        $p95Ms = Get-OptionalProperty $result "p95Ms"
        $minElements = Get-OptionalProperty $result "minElements"
        $screenshotsOk = Get-OptionalProperty $result "screenshotsOk"
        $errorText = Get-OptionalProperty $result "error"
        $reasonText = Get-OptionalProperty $result "reason"

        $Rows += [PSCustomObject]@{
          Pass = $pass.Name
          Driver = $driver.Label
          App = [string](Get-OptionalProperty $result "app")
          Status = [string](Get-OptionalProperty $result "status")
          MedianMs = if ($null -ne $medianMs) { [double]$medianMs } else { $null }
          P95Ms = if ($null -ne $p95Ms) { [double]$p95Ms } else { $null }
          MinElements = if ($null -ne $minElements) { [int]$minElements } else { $null }
          ScreenshotsOk = $screenshotsOk
          Error = if ($null -ne $errorText) { [string]$errorText } elseif ($null -ne $reasonText) { [string]$reasonText } else { $null }
          Json = $output
        }
      }
    }
  }
} finally {
  $env:CUA_DRIVER_BIN = $PriorDriver
}

Write-Host ""
Write-Host "=== Real-app exact-window compatibility ==="
$Rows |
  Select-Object Pass, Driver, App, Status, MedianMs, P95Ms, MinElements, ScreenshotsOk |
  Format-Table -AutoSize

Write-Host ""
Write-Host "=== Per-order real-app deltas (patched - official) ==="
$DeltaRows = @()
foreach ($pass in $Passes) {
  foreach ($app in @($Rows.App | Sort-Object -Unique)) {
    $official = @($Rows | Where-Object { $_.Pass -eq $pass.Name -and $_.Driver -eq "official" -and $_.App -eq $app }) | Select-Object -First 1
    $patched = @($Rows | Where-Object { $_.Pass -eq $pass.Name -and $_.Driver -eq "patched" -and $_.App -eq $app }) | Select-Object -First 1
    if ($official -and $patched -and $official.Status -eq "ok" -and $patched.Status -eq "ok") {
      $DeltaRows += [PSCustomObject]@{
        Pass = $pass.Name
        App = $app
        MedianDeltaMs = [Math]::Round($patched.MedianMs - $official.MedianMs, 2)
        MedianReductionPct = if ($official.MedianMs -gt 0) {
          [Math]::Round((1 - ($patched.MedianMs / $official.MedianMs)) * 100, 1)
        } else { 0 }
      }
    }
  }
}
$DeltaRows | Format-Table -AutoSize

Write-Host ""
Write-Host "Reports: $OutputRoot"
