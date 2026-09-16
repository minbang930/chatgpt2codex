$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-public-hostname.ps1")

function Assert-Equal([string]$Expected, [string]$Actual, [string]$Label) {
    if ($Expected -ne $Actual) {
        throw "$Label failed. Expected '$Expected', got '$Actual'."
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("chatgpt2codex-hostname-test-" + [Guid]::NewGuid().ToString("N"))
$localAppData = Join-Path $tempRoot "LocalAppData"
$roamingAppData = Join-Path $tempRoot "RoamingAppData"
$modernDir = Join-Path $localAppData "ChatGPT To Codex"
$legacyDir = Join-Path $roamingAppData "ChatGPT To Codex"
$emptyEnvironment = { param([string]$Name) return $null }

try {
    New-Item -ItemType Directory -Force -Path $modernDir, $legacyDir | Out-Null

    Assert-Equal "explicit.example.com" (
        Resolve-ChatGPT2CodexPublicHostname `
            -ExplicitValue "https://explicit.example.com/path" `
            -LocalAppData $localAppData `
            -RoamingAppData $roamingAppData `
            -EnvironmentResolver $emptyEnvironment
    ) "explicit hostname normalization"

    $modernLines = @(
        "Port=" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("7979"))
        "PublicHostname=" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("saved.example.com"))
    )
    [IO.File]::WriteAllLines(
        (Join-Path $modernDir "settings.ini"),
        $modernLines,
        [Text.Encoding]::UTF8
    )

    Assert-Equal "saved.example.com" (
        Resolve-ChatGPT2CodexPublicHostname `
            -LocalAppData $localAppData `
            -RoamingAppData $roamingAppData `
            -EnvironmentResolver $emptyEnvironment
    ) "modern launcher settings"

    [IO.File]::WriteAllText(
        (Join-Path $legacyDir "settings.json"),
        '{"PublicHostname":"legacy.example.com"}',
        [Text.Encoding]::UTF8
    )
    Assert-Equal "saved.example.com" (
        Resolve-ChatGPT2CodexPublicHostname `
            -LocalAppData $localAppData `
            -RoamingAppData $roamingAppData `
            -EnvironmentResolver $emptyEnvironment
    ) "modern settings precedence"

    Remove-Item -LiteralPath (Join-Path $modernDir "settings.ini") -Force
    Assert-Equal "legacy.example.com" (
        Resolve-ChatGPT2CodexPublicHostname `
            -LocalAppData $localAppData `
            -RoamingAppData $roamingAppData `
            -EnvironmentResolver $emptyEnvironment
    ) "legacy tray settings fallback"

    $environmentValues = @{
        "PUBLIC_HOSTNAME" = ""
        "CHATGPT2CODEX_PUBLIC_HOSTNAME" = "https://env.example.com/mcp"
    }
    $environmentResolver = {
        param([string]$Name)
        return [string]$environmentValues[$Name]
    }.GetNewClosure()

    Assert-Equal "env.example.com" (
        Resolve-ChatGPT2CodexPublicHostname `
            -LocalAppData $localAppData `
            -RoamingAppData $roamingAppData `
            -EnvironmentResolver $environmentResolver
    ) "environment alias precedence"

    $startScriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "start-chatgpt.ps1"
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $startScriptPath,
        [ref]$tokens,
        [ref]$parseErrors
    )
    if ($parseErrors.Count -gt 0) {
        throw "start-chatgpt.ps1 has PowerShell parse errors: $($parseErrors[0].Message)"
    }
    $startScriptText = $ast.Extent.Text
    if ($startScriptText -notmatch 'Resolve-ChatGPT2CodexPublicHostname') {
        throw "start-chatgpt.ps1 does not wire the saved public-hostname resolver."
    }
    if ($startScriptText -notmatch 'CHATGPT2CODEX_PUBLIC_HOSTNAME') {
        throw "start-chatgpt.ps1 does not honor CHATGPT2CODEX_PUBLIC_HOSTNAME."
    }

    Write-Host "Windows public hostname resolver tests passed."
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
