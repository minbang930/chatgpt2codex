param(
  [Parameter(Mandatory=$true)][string]$SourcePath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$SourcePath = (Resolve-Path -LiteralPath $SourcePath).Path
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) {
  Remove-Item -LiteralPath $OutputPath -Force
}

$frameworkRoots = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $frameworkRoots | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
  throw 'Could not find the .NET Framework C# compiler (csc.exe)'
}

function Find-WpfAssembly([string]$Name, [string[]]$ReferenceRoots, [switch]$ForceRuntimeFallback) {
  if (-not $ForceRuntimeFallback) {
    foreach ($root in $ReferenceRoots) {
      $candidate = Join-Path $root ($Name + '.dll')
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    }
  }

  $runtimeRoots = @(
    (Join-Path (Split-Path -Parent $csc) 'WPF'),
    (Join-Path $env:WINDIR 'Microsoft.NET\assembly')
  )

  foreach ($root in $runtimeRoots) {
    if (-not (Test-Path -LiteralPath $root)) {
      continue
    }

    $direct = Join-Path $root ($Name + '.dll')
    if (Test-Path -LiteralPath $direct -PathType Leaf) {
      return (Resolve-Path -LiteralPath $direct).Path
    }

    $match = Get-ChildItem -LiteralPath $root -Filter ($Name + '.dll') -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($match) {
      return $match.FullName
    }
  }

  return $null
}

$compilerArgs = @(
  '/nologo',
  '/target:winexe',
  '/optimize+',
  ('/out:' + $OutputPath),
  '/reference:System.dll'
)

if ([IO.Path]::GetFileName($SourcePath) -ieq 'computer-use-benchmark-wpf.cs') {
  $referenceRoots = @()
  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  if ($programFilesX86) {
    $netFrameworkRefs = Join-Path $programFilesX86 'Reference Assemblies\Microsoft\Framework\.NETFramework'
    if (Test-Path -LiteralPath $netFrameworkRefs) {
      $referenceRoots += Get-ChildItem -LiteralPath $netFrameworkRefs -Directory |
        Sort-Object Name -Descending |
        ForEach-Object { $_.FullName }
    }
  }

  $forceRuntimeFallback = $env:CHATGPT2CODEX_FORCE_WPF_RUNTIME_REFS -match '^(1|true|yes|on)$'
  $required = @(
    'WindowsBase',
    'PresentationCore',
    'PresentationFramework',
    'System.Xaml'
  )

  $resolvedReferences = @()
  foreach ($assemblyName in $required) {
    $resolved = Find-WpfAssembly -Name $assemblyName -ReferenceRoots $referenceRoots -ForceRuntimeFallback:$forceRuntimeFallback
    if (-not $resolved) {
      throw "Could not find WPF assembly: $assemblyName.dll. Install the .NET Framework Developer Pack or ensure the Windows .NET Framework runtime/GAC is intact."
    }
    $resolvedReferences += $resolved
  }

  Write-Host 'WPF references:'
  $resolvedReferences | ForEach-Object { Write-Host ('  ' + $_) }
  $compilerArgs += $resolvedReferences | ForEach-Object { '/reference:' + $_ }
} else {
  $compilerArgs += @(
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll'
  )
}

$compilerArgs += $SourcePath
& $csc @compilerArgs

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath)) {
  throw "benchmark fixture compilation failed with exit code $LASTEXITCODE"
}
