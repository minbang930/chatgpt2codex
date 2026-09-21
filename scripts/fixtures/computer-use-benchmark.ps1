param(
  [Parameter(Mandatory=$true)][string]$StatePath,
  [Parameter(Mandatory=$true)][string]$Title
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Write-State([string]$submitted) {
  $payload = @{ submitted = $submitted; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($StatePath, $payload, [Text.UTF8Encoding]::new($false))
}

Write-State $null

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Width = 560
$form.Height = 240
$form.StartPosition = 'CenterScreen'
$form.TopMost = $false

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Enter benchmark token'
$label.Left = 24
$label.Top = 24
$label.Width = 220

$text = New-Object System.Windows.Forms.TextBox
$text.Left = 24
$text.Top = 56
$text.Width = 480
$text.Name = 'BenchmarkInput'
$text.AccessibleName = 'BenchmarkInput'

$button = New-Object System.Windows.Forms.Button
$button.Left = 24
$button.Top = 104
$button.Width = 120
$button.Height = 34
$button.Text = 'Submit'
$button.Name = 'BenchmarkSubmit'
$button.AccessibleName = 'BenchmarkSubmit'

$status = New-Object System.Windows.Forms.Label
$status.Left = 168
$status.Top = 112
$status.Width = 336
$status.Text = 'Waiting'

$button.Add_Click({
  Write-State $text.Text
  $status.Text = 'Submitted: ' + $text.Text
})

$form.Controls.AddRange(@($label, $text, $button, $status))
[System.Windows.Forms.Application]::Run($form)
