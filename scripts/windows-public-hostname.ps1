$startupContextHelper = Join-Path $PSScriptRoot "windows-startup-context.ps1"
if (Test-Path -LiteralPath $startupContextHelper) {
    . $startupContextHelper

    # start-chatgpt.ps1 dot-sources this helper before applying its legacy
    # `$HOME\workspace` fallback. When an active project root was supplied but
    # no workspace was supplied, make that project the workspace root so the
    # startup project is guaranteed to be present in scanWorkspace(). Tests
    # that dot-source this helper without launcher variables remain unaffected.
    $workspaceVariable = Get-Variable -Name Workspace -Scope 0 -ErrorAction SilentlyContinue
    $activeProjectVariable = Get-Variable -Name ActiveProjectRoot -Scope 0 -ErrorAction SilentlyContinue
    if ($workspaceVariable -and $activeProjectVariable -and
        [string]::IsNullOrWhiteSpace([string]$workspaceVariable.Value) -and
        -not [string]::IsNullOrWhiteSpace([string]$activeProjectVariable.Value)) {
        $resolvedWorkspace = Resolve-ChatGPT2CodexWorkspace `
            -Workspace ([string]$workspaceVariable.Value) `
            -ActiveProjectRoot ([string]$activeProjectVariable.Value)
        Set-Variable -Name Workspace -Value $resolvedWorkspace -Scope 0
        Write-Host "[chatgpt2codex] using active project as workspace: $resolvedWorkspace"
    }
}

function Normalize-ChatGPT2CodexPublicHostname([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }

    $trimmed = $Value.Trim()
    try {
        $uri = $null
        if ([System.Uri]::TryCreate($trimmed, [System.UriKind]::Absolute, [ref]$uri) -and $uri.Host) {
            return $uri.Host
        }
    } catch {
    }

    return $trimmed.TrimEnd('/')
}

function Get-ChatGPT2CodexEncodedIniSetting([string]$Path, [string]$Key) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.File]::Exists($Path)) { return $null }

    try {
        foreach ($rawLine in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
            if ($null -eq $rawLine) { continue }
            $line = ([string]$rawLine).TrimStart([char]0xFEFF)
            $index = $line.IndexOf('=')
            if ($index -le 0) { continue }
            if (-not $line.Substring(0, $index).Equals($Key, [System.StringComparison]::Ordinal)) { continue }

            $encoded = $line.Substring($index + 1).Trim()
            if ([string]::IsNullOrWhiteSpace($encoded)) { return $null }
            $bytes = [System.Convert]::FromBase64String($encoded)
            return [System.Text.Encoding]::UTF8.GetString($bytes)
        }
    } catch {
    }
    return $null
}

function Resolve-ChatGPT2CodexPublicHostname {
    [CmdletBinding()]
    param(
        [string]$ExplicitValue,
        [string]$LocalAppData = $env:LOCALAPPDATA,
        [string]$RoamingAppData = $env:APPDATA,
        [scriptblock]$EnvironmentResolver
    )

    if (-not $EnvironmentResolver) {
        $EnvironmentResolver = {
            param([string]$Name)
            foreach ($scope in @("Process", "User", "Machine")) {
                try {
                    $value = [System.Environment]::GetEnvironmentVariable($Name, $scope)
                    if (-not [string]::IsNullOrWhiteSpace($value)) {
                        return $value.Trim()
                    }
                } catch {
                }
            }
            return $null
        }
    }

    foreach ($candidate in @(
        $ExplicitValue,
        (& $EnvironmentResolver "PUBLIC_HOSTNAME"),
        (& $EnvironmentResolver "CHATGPT2CODEX_PUBLIC_HOSTNAME")
    )) {
        $normalized = Normalize-ChatGPT2CodexPublicHostname $candidate
        if ($normalized) { return $normalized }
    }

    if (-not [string]::IsNullOrWhiteSpace($LocalAppData)) {
        $modernSettings = Join-Path (Join-Path $LocalAppData "ChatGPT To Codex") "settings.ini"
        $modernValue = Get-ChatGPT2CodexEncodedIniSetting $modernSettings "PublicHostname"
        $normalized = Normalize-ChatGPT2CodexPublicHostname $modernValue
        if ($normalized) { return $normalized }
    }

    if (-not [string]::IsNullOrWhiteSpace($RoamingAppData)) {
        $legacySettings = Join-Path (Join-Path $RoamingAppData "ChatGPT To Codex") "settings.json"
        if (Test-Path -LiteralPath $legacySettings) {
            try {
                $legacy = Get-Content -LiteralPath $legacySettings -Raw -ErrorAction Stop | ConvertFrom-Json
                $normalized = Normalize-ChatGPT2CodexPublicHostname ([string]$legacy.PublicHostname)
                if ($normalized) { return $normalized }
            } catch {
            }
        }
    }

    return $null
}
