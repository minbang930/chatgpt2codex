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

# Windows PowerShell 5.1 treats UTF-8 files without a BOM as the active ANSI
# code page when Get-Content is used without -Encoding. The launcher source
# intentionally contains Korean/Japanese/Chinese/etc. UI strings, so that
# behavior corrupts the C# source before Add-Type sees it and can turn a valid
# quoted string into a compiler error. Read with a strict UTF-8 decoder on all
# PowerShell versions instead of depending on shell-specific defaults.
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$sourceText = [System.IO.File]::ReadAllText($source, $utf8)

$refs = @("System.Windows.Forms.dll", "System.Drawing.dll")
$addType = Get-Command Add-Type

# PowerShell 7 exposes -CompilerOptions, while Windows PowerShell 5.1 (the
# shell used by the npm windows:exe script on a normal Windows 11 install)
# exposes -CompilerParameters instead. Keep both paths so source builds work
# from either shell.
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
    # Windows PowerShell 5.1 rejects -CompilerParameters when Add-Type is also
    # given -OutputAssembly/-OutputType. Configure *all* output/compiler state
    # directly on CompilerParameters and pass only that parameter set.
    $cp = New-Object System.CodeDom.Compiler.CompilerParameters
    $cp.GenerateExecutable = $true
    $cp.GenerateInMemory = $false
    $cp.OutputAssembly = $out
    [void]$cp.ReferencedAssemblies.Add("System.dll")
    [void]$cp.ReferencedAssemblies.Add("System.Core.dll")
    foreach ($ref in $refs) {
        [void]$cp.ReferencedAssemblies.Add($ref)
    }

    $compilerOptions = "/target:winexe"
    if (Test-Path $iconIco) {
        $compilerOptions = "$compilerOptions /win32icon:`"$iconIco`""
    }
    $cp.CompilerOptions = $compilerOptions

    Add-Type -TypeDefinition $sourceText -CompilerParameters $cp
} else {
    throw "This PowerShell Add-Type implementation exposes neither CompilerOptions nor CompilerParameters."
}

if (-not (Test-Path $out)) {
    throw "Launcher build completed without producing: $out"
}

Write-Host "[chatgpt2codex] built $out"
