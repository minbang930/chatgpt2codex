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
  if (Get-Command $Name -ErrorAction SilentlyContinue) {
    return
  }

  if ($Name -eq "cargo") {
    $cargoBin = Join-Path $HOME ".cargo\bin"
    $cargoExe = Join-Path $cargoBin "cargo.exe"
    if (Test-Path $cargoExe -PathType Leaf) {
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

Then rerun:
  npm run benchmark:cua-fast-path
"@
  }

  throw "Required command is not on PATH: $Name"
}

function Require-SpectreLibraries {
  $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
  if (-not $programFilesX86) {
    return
  }

  $vswhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere -PathType Leaf)) {
    return
  }

  $spectreInstall = (
    & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre -property installationPath |
      Select-Object -First 1
  )

  if (-not $spectreInstall) {
    throw @"
Cua Driver's Windows dependency graph requires the MSVC Spectre-mitigated x64/x86 libraries.

Add this Visual Studio component:
  Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre

GUI:
  Visual Studio Installer -> Build Tools -> Modify -> Individual components
  -> search "Spectre" -> select the latest x64/x86 Spectre-mitigated libs.

After installation, open a new PowerShell and rerun:
  npm run benchmark:cua-fast-path
"@
  }
}

function Import-VsDevEnvironment {
  if (Get-Command link.exe -ErrorAction SilentlyContinue) {
    return
  }

  $candidateRoots = @()
  $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
  if ($programFilesX86) {
    $candidateRoots += (Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe")
  }
  if ($env:ProgramFiles) {
    $candidateRoots += (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe")
  }

  $vswhere = $candidateRoots |
    Where-Object { Test-Path $_ -PathType Leaf } |
    Select-Object -First 1

  if ($vswhere) {
    $installationPath = (
      & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath |
        Select-Object -First 1
    )

    if ($installationPath) {
      $vsDevCmd = Join-Path $installationPath "Common7\Tools\VsDevCmd.bat"
      if (Test-Path $vsDevCmd -PathType Leaf) {
        Write-Host "Loading Visual Studio C++ build environment..."
        $cmdLine = 'call "{0}" -arch=x64 -host_arch=x64 >nul && set' -f $vsDevCmd
        $envDump = & $env:ComSpec /d /s /c $cmdLine
        if ($LASTEXITCODE -ne 0) {
          throw "VsDevCmd.bat failed with exit code $LASTEXITCODE"
        }

        foreach ($line in $envDump) {
          if ($line -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
          }
        }
      }
    }
  }

  if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
    throw @"
MSVC linker (link.exe) is required for the Rust x86_64-pc-windows-msvc target.

Install Visual Studio Build Tools with Desktop C++ support:
  winget install -e --id Microsoft.VisualStudio.BuildTools --source winget --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

If winget reports installer error 1603, open Visual Studio Installer and Modify/Repair Build Tools, enabling "Desktop development with C++".

After installation, open a new PowerShell and rerun:
  npm run benchmark:cua-fast-path
"@
  }
}

Require-Command git
Require-Command cargo
Import-VsDevEnvironment
Require-SpectreLibraries

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
