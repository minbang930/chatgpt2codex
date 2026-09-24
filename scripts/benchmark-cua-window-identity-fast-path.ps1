param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OutputRoot = Join-Path $ProjectRoot ".chatgpt2codex\benchmarks\cua-window-identity"
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
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Read-Utf8Json([string]$Path) {
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  return ($text | ConvertFrom-Json)
}

function Get-OptionalProperty([object]$Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Invoke-Identity(
  [string]$Label,
  [string]$Binary,
  [string]$Output
) {
  Write-Host ""
  Write-Host "=== identity / $Label ==="
  Write-Host "Driver: $Binary"
  $env:CUA_DRIVER_BIN = $Binary
  Push-Location $ProjectRoot
  try {
    & npm run benchmark:cua-window-identity -- --output $Output
    if ($LASTEXITCODE -ne 0) {
      throw "$Label identity benchmark failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

$PriorDriver = $env:CUA_DRIVER_BIN
$Rows = @()

try {
  foreach ($driver in @(
    [PSCustomObject]@{ Label = "official"; Binary = $OfficialBinary },
    [PSCustomObject]@{ Label = "patched"; Binary = $PatchedBinary }
  )) {
    $output = Join-Path $OutputRoot "$Stamp-$($driver.Label).json"
    Invoke-Identity $driver.Label $driver.Binary $output
    $report = Read-Utf8Json $output

    $background = Get-OptionalProperty $report "backgroundB"
    $minimized = Get-OptionalProperty $report "minimized"
    $minimizedObservation = Get-OptionalProperty $minimized "observation"
    $wrongPid = Get-OptionalProperty $report "wrongPid"
    $staleWindow = Get-OptionalProperty $report "staleWindow"

    $Rows += [PSCustomObject]@{
      Driver = $driver.Label
      Status = [string](Get-OptionalProperty $report "status")
      IdentityMatch = [bool](Get-OptionalProperty $report "identityMatch")
      TitlesMatch = [bool](Get-OptionalProperty $report "titlesMatch")
      BackgroundOk = [bool](Get-OptionalProperty $background "ok")
      MinimizedOk = [bool](Get-OptionalProperty $minimizedObservation "ok")
      MinimizedError = [string](Get-OptionalProperty $minimizedObservation "error")
      WrongPidRejected = [bool](Get-OptionalProperty $wrongPid "rejected")
      StaleRejected = [bool](Get-OptionalProperty $staleWindow "rejected")
      Json = $output
    }
  }
} finally {
  $env:CUA_DRIVER_BIN = $PriorDriver
}

Write-Host ""
Write-Host "=== Cua exact-window identity regression ==="
$Rows |
  Select-Object Driver, Status, IdentityMatch, TitlesMatch, BackgroundOk, MinimizedOk, WrongPidRejected, StaleRejected |
  Format-Table -AutoSize

$official = @($Rows | Where-Object { $_.Driver -eq "official" }) | Select-Object -First 1
$patched = @($Rows | Where-Object { $_.Driver -eq "patched" }) | Select-Object -First 1

Write-Host ""
if ($official -and $patched) {
  $coreParity =
    $official.Status -eq $patched.Status -and
    $official.IdentityMatch -eq $patched.IdentityMatch -and
    $official.TitlesMatch -eq $patched.TitlesMatch -and
    $official.BackgroundOk -eq $patched.BackgroundOk -and
    $official.WrongPidRejected -eq $patched.WrongPidRejected -and
    $official.StaleRejected -eq $patched.StaleRejected
  Write-Host "Core official/patched parity: $coreParity"
  Write-Host "Minimized official/patched: $($official.MinimizedOk) / $($patched.MinimizedOk)"
  if ($official.MinimizedError) { Write-Host "Official minimized error: $($official.MinimizedError)" }
  if ($patched.MinimizedError) { Write-Host "Patched minimized error:  $($patched.MinimizedError)" }
}
Write-Host "Reports: $OutputRoot"
