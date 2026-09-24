param(
  [string]$SourcePath,
  [string]$RuntimeRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PersistedProjectBinary = Join-Path $ProjectRoot ".chatgpt2codex\bin\cua-driver-fast-path.exe"
$TargetBuildBinary = Join-Path $ProjectRoot ".chatgpt2codex\cua-driver-fast-path\cua\libs\cua-driver\rust\target\release\cua-driver.exe"
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $RuntimeRoot = Join-Path $HOME ".local\share\chatgpt2codex\cua-driver\fast-path"
}
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$RuntimeBinary = Join-Path $RuntimeRoot "cua-driver.exe"

function Get-Sha256Hex([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes)).Replace("-", "")
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  if (Test-Path -LiteralPath $PersistedProjectBinary -PathType Leaf) {
    $SourcePath = $PersistedProjectBinary
  } elseif (Test-Path -LiteralPath $TargetBuildBinary -PathType Leaf) {
    $SourcePath = $TargetBuildBinary
  } else {
    throw @"
Patched Cua Driver binary not found.

Build it first:
  npm run cua:build-fast-path -- -SkipTests

Expected one of:
  $PersistedProjectBinary
  $TargetBuildBinary
"@
  }
}

$SourcePath = [System.IO.Path]::GetFullPath($SourcePath)
if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
  throw "Source Cua Driver binary does not exist: $SourcePath"
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null

$temp = Join-Path $RuntimeRoot ("cua-driver.exe.tmp-" + [Guid]::NewGuid().ToString("N"))
try {
  Copy-Item -LiteralPath $SourcePath -Destination $temp -Force
  Move-Item -LiteralPath $temp -Destination $RuntimeBinary -Force
} finally {
  Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
}

$sourceHash = Get-Sha256Hex $SourcePath
$runtimeHash = Get-Sha256Hex $RuntimeBinary
if ($sourceHash -ne $runtimeHash) {
  throw "Installed fast-path Cua Driver hash mismatch"
}

Write-Host ""
Write-Host "Installed fast-path Cua Driver:"
Write-Host "  $RuntimeBinary"
Write-Host "SHA256:"
Write-Host "  $runtimeHash"
Write-Host ""
Write-Host "Enable it for the current PowerShell:"
Write-Host '  $env:CHATGPT2CODEX_CUA_DRIVER_VARIANT = "fast-path"'
Write-Host '  $env:CHATGPT2CODEX_WINDOWS_BACKEND = "cua"'
Write-Host ""
Write-Host "Rollback:"
Write-Host '  Remove-Item Env:CHATGPT2CODEX_CUA_DRIVER_VARIANT -ErrorAction SilentlyContinue'
Write-Host '  # or set CHATGPT2CODEX_CUA_DRIVER_VARIANT=system'
Write-Output $RuntimeBinary
