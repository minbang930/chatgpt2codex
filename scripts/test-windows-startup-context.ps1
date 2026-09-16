$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-startup-context.ps1")

function Assert-Equal([string]$Expected, [string]$Actual, [string]$Label) {
    if ($Expected -ne $Actual) {
        throw "$Label failed. Expected '$Expected', got '$Actual'."
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("chatgpt2codex-startup-context-test-" + [Guid]::NewGuid().ToString("N"))
try {
    $explicitWorkspace = Join-Path $tempRoot "explicit-workspace"
    $activeProject = Join-Path $tempRoot "active-project"
    $homePath = Join-Path $tempRoot "home"

    Assert-Equal ([System.IO.Path]::GetFullPath($explicitWorkspace)) (
        Resolve-ChatGPT2CodexWorkspace -Workspace $explicitWorkspace -ActiveProjectRoot $activeProject -HomePath $homePath
    ) "explicit workspace precedence"

    Assert-Equal ([System.IO.Path]::GetFullPath($activeProject)) (
        Resolve-ChatGPT2CodexWorkspace -Workspace "" -ActiveProjectRoot $activeProject -HomePath $homePath
    ) "active project workspace fallback"

    Assert-Equal ([System.IO.Path]::GetFullPath((Join-Path $homePath "workspace"))) (
        Resolve-ChatGPT2CodexWorkspace -Workspace "" -ActiveProjectRoot "" -HomePath $homePath
    ) "default home workspace fallback"

    Write-Host "Windows startup context tests passed."
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
