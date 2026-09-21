param(
  [Parameter(Mandatory=$true)][string]$SourcePath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $OutputPath) {
  Remove-Item -LiteralPath $OutputPath -Force
}

$source = [IO.File]::ReadAllText($SourcePath)
Add-Type -TypeDefinition $source `
  -Language CSharp `
  -ReferencedAssemblies @('System.Windows.Forms.dll', 'System.Drawing.dll') `
  -OutputAssembly $OutputPath `
  -OutputType WindowsApplication

if (-not (Test-Path -LiteralPath $OutputPath)) {
  throw "benchmark fixture compiler did not create $OutputPath"
}
