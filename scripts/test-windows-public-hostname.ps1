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

    $modernValue = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("saved.example.com"))
    Set-Content -LiteralPath (Join-Path $modernDir "settings.ini") -Encoding UTF8 -Value @(
        "Port=" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("7979")),
        "PublicHostname=$modernValue"
    )

    Assert-Equal "saved.example.com" (
        Resolve-ChatGPT2CodexPublicHostname `
            -LocalAppData $localAppData `
            -RoamingAppData $roamingAppData `
            -EnvironmentResolver $emptyEnvironment
    ) "modern launcher settings"

    Set-Content -LiteralPath (Join-Path $legacyDir "settings.json") -Encoding UTF8 -Value '{"PublicHostname":"legacy.example.com"}'
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

    Write-Host "Windows public hostname resolver tests passed."
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
