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
  $compilerArgs += @(
    '/reference:WindowsBase.dll',
    '/reference:PresentationCore.dll',
    '/reference:PresentationFramework.dll'
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
