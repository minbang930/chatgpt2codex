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
  $referenceRoots += (Join-Path (Split-Path -Parent $csc) 'WPF')

  $wpfReferenceRoot = $referenceRoots |
    Where-Object {
      (Test-Path -LiteralPath (Join-Path $_ 'WindowsBase.dll')) -and
      (Test-Path -LiteralPath (Join-Path $_ 'PresentationCore.dll')) -and
      (Test-Path -LiteralPath (Join-Path $_ 'PresentationFramework.dll')) -and
      (Test-Path -LiteralPath (Join-Path $_ 'System.Xaml.dll'))
    } |
    Select-Object -First 1

  if (-not $wpfReferenceRoot) {
    throw 'Could not find .NET Framework WPF reference assemblies'
  }

  $compilerArgs += @(
    ('/reference:' + (Join-Path $wpfReferenceRoot 'WindowsBase.dll')),
    ('/reference:' + (Join-Path $wpfReferenceRoot 'PresentationCore.dll')),
    ('/reference:' + (Join-Path $wpfReferenceRoot 'PresentationFramework.dll')),
    ('/reference:' + (Join-Path $wpfReferenceRoot 'System.Xaml.dll'))
  )
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
