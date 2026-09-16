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
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $null }

    try {
        foreach ($line in Get-Content -LiteralPath $Path -ErrorAction Stop) {
            $index = $line.IndexOf('=')
            if ($index -le 0) { continue }
            if ($line.Substring(0, $index) -ne $Key) { continue }

            $encoded = $line.Substring($index + 1)
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
