function Resolve-ChatGPT2CodexWorkspace {
    [CmdletBinding()]
    param(
        [string]$Workspace,
        [string]$ActiveProjectRoot,
        [string]$HomePath = $HOME
    )

    if (-not [string]::IsNullOrWhiteSpace($Workspace)) {
        return [System.IO.Path]::GetFullPath($Workspace)
    }

    if (-not [string]::IsNullOrWhiteSpace($ActiveProjectRoot)) {
        return [System.IO.Path]::GetFullPath($ActiveProjectRoot)
    }

    if ([string]::IsNullOrWhiteSpace($HomePath)) {
        throw "Cannot resolve the default workspace because HOME is empty."
    }

    return [System.IO.Path]::GetFullPath((Join-Path $HomePath "workspace"))
}
