param(
  [string]$WorkRoot = "",
  [switch]$SkipTests,
  [switch]$ForceRefresh
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PinnedCommit = "9bbfa7dd3e27ca7f1861ede70aaca390174493f9"
$Upstream = "https://github.com/trycua/cua.git"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
  $WorkRoot = Join-Path $ProjectRoot ".chatgpt2codex\cua-driver-fast-path"
}
$SourceRoot = Join-Path $WorkRoot "cua"
$PatchPath = Join-Path $ProjectRoot "patches\cua-driver\get-window-state-exact-window-fast-path.patch"
$RustRoot = Join-Path $SourceRoot "libs\cua-driver\rust"
$BinaryPath = Join-Path $RustRoot "target\release\cua-driver.exe"

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    if ($Name -eq "cargo") {
      $cargoBin = Join-Path $HOME ".cargo\bin"
      if (Test-Path (Join-Path $cargoBin "cargo.exe") -PathType Leaf) {
        $env:PATH = "$cargoBin;$env:PATH"
        return
      }
      throw @"
Rust/Cargo is required to build the patched Cua Driver.

Install Rust with rustup, then open a new PowerShell:
  winget install -e --id Rustlang.Rustup

Verify:
  cargo --version
  rustc --version

If the build later reports that link.exe/MSVC is missing, install Visual Studio Build Tools with the Desktop C++ workload:
  winget install -e --id Microsoft.VisualStudio.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

Then rerun:
  npm run benchmark:cua-fast-path
"@
    }
    throw "Required command is not on PATH: $Name"
  }
}

Require-Command git
Require-Command cargo

if (-not (Test-Path $PatchPath -PathType Leaf)) {
  throw "Patch file not found: $PatchPath"
}

New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null

if ($ForceRefresh -and (Test-Path $SourceRoot)) {
  Remove-Item -Recurse -Force $SourceRoot
}

if (-not (Test-Path (Join-Path $SourceRoot ".git") -PathType Container)) {
  Write-Host "Cloning Cua Driver source at pinned revision..."
  & git clone --filter=blob:none --no-checkout $Upstream $SourceRoot
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}

Write-Host "Resetting Cua source to $PinnedCommit..."
& git -C $SourceRoot fetch --depth 1 origin $PinnedCommit
if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
& git -C $SourceRoot checkout --detach $PinnedCommit
if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }
& git -C $SourceRoot reset --hard $PinnedCommit
if ($LASTEXITCODE -ne 0) { throw "git reset failed" }
# Remove untracked source files but preserve ignored Cargo target/registry data.
& git -C $SourceRoot clean -fd
if ($LASTEXITCODE -ne 0) { throw "git clean failed" }

Write-Host "Checking and applying get_window_state exact-window fast path..."
& git -C $SourceRoot apply --check $PatchPath
if ($LASTEXITCODE -ne 0) {
  throw "Patch no longer applies cleanly to pinned Cua commit $PinnedCommit"
}
& git -C $SourceRoot apply $PatchPath
if ($LASTEXITCODE -ne 0) { throw "git apply failed" }

Push-Location $RustRoot
try {
  Write-Host "Checking Rust formatting..."
  & cargo fmt --all -- --check
  if ($LASTEXITCODE -ne 0) { throw "cargo fmt check failed" }

  if (-not $SkipTests) {
    Write-Host "Running focused platform-windows exact-window tests..."
    & cargo test -p platform-windows exact_window_tests --lib
    if ($LASTEXITCODE -ne 0) { throw "focused Cua Driver test failed" }
  }

  Write-Host "Building patched cua-driver release binary..."
  & cargo build -p cua-driver --release
  if ($LASTEXITCODE -ne 0) { throw "cargo release build failed" }
} finally {
  Pop-Location
}

if (-not (Test-Path $BinaryPath -PathType Leaf)) {
  throw "Patched binary was not produced: $BinaryPath"
}

Write-Host ""
Write-Host "Patched Cua Driver ready:"
Write-Host "  $BinaryPath"
Write-Output $BinaryPath
