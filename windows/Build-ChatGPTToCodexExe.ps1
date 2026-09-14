$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $scriptDir "..")
$source = Join-Path $scriptDir "ChatGPTToCodexLauncher.cs"
$out = Join-Path $root "ChatGPT To Codex.exe"
$iconPng = Join-Path $root "assets\chatgpt2codex-icon.png"
$iconIco = Join-Path $root "assets\chatgpt2codex-icon.ico"

if (-not (Test-Path $source)) {
    throw "Launcher source not found: $source"
}

if ((Test-Path $iconPng) -and -not (Test-Path $iconIco)) {
    Add-Type -AssemblyName System.Drawing
    $bitmap = [System.Drawing.Bitmap]::FromFile($iconPng)
    try {
        $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
        try {
            $stream = [System.IO.File]::Create($iconIco)
            try { $icon.Save($stream) } finally { $stream.Dispose() }
        } finally {
            $icon.Dispose()
        }
    } finally {
        $bitmap.Dispose()
    }
}

if (Test-Path $out) {
    Remove-Item -Force $out
}

$sourceText = Get-Content -Raw $source
$refs = @("System.Windows.Forms.dll", "System.Drawing.dll")
$addType = Get-Command Add-Type

# PowerShell 7 exposes -CompilerOptions, while Windows PowerShell 5.1 (the
# shell used by the npm windows:exe script on a normal Windows 11 install)
# exposes -CompilerParameters instead. Keep both paths so source builds work
# from either shell. /target:winexe is already supplied by -OutputType; the
# optional compiler argument here is only for the embedded application icon.
if ($addType.Parameters.ContainsKey("CompilerOptions")) {
    $compilerOptions = @()
    if (Test-Path $iconIco) {
        $compilerOptions += "/win32icon:`"$iconIco`""
    }

    $params = @{
        TypeDefinition = $sourceText
        ReferencedAssemblies = $refs
        OutputAssembly = $out
        OutputType = "WindowsApplication"
    }
    if ($compilerOptions.Count -gt 0) {
        $params.CompilerOptions = $compilerOptions
    }
    Add-Type @params
} elseif ($addType.Parameters.ContainsKey("CompilerParameters")) {
    # Windows PowerShell 5.1 does not allow -CompilerParameters together with
    # -ReferencedAssemblies, so place the references on CompilerParameters.
    $cp = New-Object System.CodeDom.Compiler.CompilerParameters
    $cp.GenerateExecutable = $true
    $cp.GenerateInMemory = $false
    [void]$cp.ReferencedAssemblies.Add("System.dll")
    [void]$cp.ReferencedAssemblies.Add("System.Core.dll")
    foreach ($ref in $refs) {
        [void]$cp.ReferencedAssemblies.Add($ref)
    }
    if (Test-Path $iconIco) {
        $cp.CompilerOptions = "/win32icon:`"$iconIco`""
    }

    Add-Type `
        -TypeDefinition $sourceText `
        -CompilerParameters $cp `
        -OutputAssembly $out `
        -OutputType WindowsApplication
} else {
    throw "This PowerShell Add-Type implementation exposes neither CompilerOptions nor CompilerParameters."
}

if (-not (Test-Path $out)) {
    throw "Launcher build completed without producing: $out"
}

Write-Host "[chatgpt2codex] built $out"
