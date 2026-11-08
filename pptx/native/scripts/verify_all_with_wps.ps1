# Open every generated deck in the second reader and report what it sees.
#
# Microsoft PowerPoint is not installed here, so this is WPS Presentation through its
# PowerPoint-compatible COM surface - a different reader from LibreOffice, not a
# substitute for the real thing. See docs in pipeline/README.md.
#
# Usage: pwsh -NoProfile -File scripts/verify_all_with_wps.ps1 [-Directory pipeline-converted]

param(
  [string]$Directory = 'pipeline-converted',
  [string[]]$Also = @()
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Directory).Path
$decks = @(Get-ChildItem -LiteralPath $root -Filter '*.pptx' | Sort-Object Name | Select-Object -ExpandProperty FullName)
foreach ($extra in $Also) {
  if (Test-Path -LiteralPath $extra) { $decks += (Resolve-Path -LiteralPath $extra).Path }
}
if ($decks.Count -eq 0) { Write-Error "no decks found in $root"; exit 1 }

$failures = @()
foreach ($deck in $decks) {
  $name = Split-Path -Leaf $deck
  $json = pwsh -NoProfile -File (Join-Path $PSScriptRoot 'verify_with_wps.ps1') -Deck $deck 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    $failures += "$name (exit $code)"
    Write-Host ("FAIL  {0} :: {1}" -f $name, ($json | Select-Object -Last 1))
    continue
  }
  $report = ($json | Out-String) | ConvertFrom-Json
  $shapeTotal = ($report.shapes | Measure-Object -Property shapes -Sum).Sum
  Write-Host ("ok    {0} :: slides={1} shapes={2} chars={3}" -f $name, $report.slides, $shapeTotal, $report.characters)
}

if ($failures.Count -gt 0) {
  Write-Error ("decks that did not open cleanly: " + ($failures -join ', '))
  exit 1
}
Write-Host ("all {0} deck(s) opened in the second reader" -f $decks.Count)
exit 0
