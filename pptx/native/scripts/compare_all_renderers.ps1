# Render the same decks in two independent readers and check that the ink lands in the
# same place.
#
# LibreOffice is one reader; WPS Presentation through its PowerPoint-compatible COM
# surface is the other. Microsoft PowerPoint is not installed here, so this is the
# strongest cross-reader evidence available: two commercial implementations agreeing on
# where the ink is, judged on dilated ink overlap rather than on pixels (they cannot share
# fonts, and a global SSIM collapses on a dark page while the layout is identical - see
# compare_renderers.py).
#
# Usage: pwsh -NoProfile -File scripts/compare_all_renderers.ps1 [-Decks a,b] [-Directory pipeline-converted]

param(
  [string[]]$Decks = @('pipeline-structural', 'pipeline-paginate', 'pipeline-decorations',
    'pipeline-chart', 'pipeline-stress', 'pipeline-vertical', 'pipeline-columns', 'pipeline-grid',
    # A deck of pictures: crops, background sizes, and the paint order inside a card.
    'pipeline-media',
    # Declared column widths, row rules and the cell box model.
    'pipeline-table'),
  [string]$Directory = 'pipeline-converted',
  # Pages whose body text a reader flows itself: each implementation breaks the lines with its
  # own fonts, so the ink inside the box moves while the box does not. They are not skipped -
  # they are judged on the block the text fills, which is a smaller claim than the pixel judge
  # and a real one: a box in the wrong place, or a reader that drops the flow to one column,
  # fails it.
  [hashtable]$Flowed = @{ 'pipeline-columns' = '1' },
  # Pages with no honest cross-reader claim at all, by deck.
  [hashtable]$Skip = @{}
)

$ErrorActionPreference = 'Stop'
$failures = @()
$rows = @()
foreach ($name in $Decks) {
  $deck = Join-Path $Directory ($name + '.pptx')
  if (-not (Test-Path -LiteralPath $deck)) { Write-Host ("skip  {0} :: no deck" -f $name); continue }
  $left = Join-Path 'render-check' $name
  $right = Join-Path 'render-wps' $name
  & python scripts/render_check.py $deck --output-dir $left | Out-Null
  if ($LASTEXITCODE -ne 0) { $failures += "$name (libreoffice render)"; continue }
  & pwsh -NoProfile -File scripts/verify_with_wps.ps1 -Deck $deck -ExportDir $right | Out-Null
  if ($LASTEXITCODE -ne 0) { $failures += "$name (wps export)"; continue }
  $skipArg = @()
  if ($Skip.ContainsKey($name)) { $skipArg += @('--skip', $Skip[$name]) }
  if ($Flowed.ContainsKey($name)) { $skipArg += @('--flowed', $Flowed[$name]) }
  $raw = & python scripts/compare_renderers.py --a $left --b $right @skipArg 2>&1 | Out-String
  try { $report = $raw | ConvertFrom-Json } catch { $failures += "$name (compare output)"; Write-Host $raw; continue }
  $measured = @($report.slides | Where-Object { $_.ink_iou })
  if ($measured.Count -eq 0) { $failures += "$name (nothing measured)"; continue }
  $judged = @($measured | Where-Object { $_.status -ne 'skipped' -and $_.check -ne 'flowed text start' })
  $flowedRows = @($measured | Where-Object { $_.check -eq 'flowed text start' })
  if ($judged.Count -eq 0 -and $flowedRows.Count -eq 0) { Write-Host ("skip  {0} :: nothing judged" -f $name); continue }
  if ($judged.Count -eq 0) {
    $worstBlock = ($flowedRows | Measure-Object -Property block_delta_px -Maximum)
    $rows += [pscustomobject]@{
      deck = $name; slides = 0; flowed = [int]$flowedRows.Count; skipped = [int]$report.skipped
      passed = $report.passed; min_ink = $null; worst_slide = $null
      max_mae = $null; max_changed = $null
    }
    if (-not $report.passed) { $failures += ("{0} (flowed block moved)" -f $name) }
    continue
  }
  $lowest = $judged | Sort-Object ink_iou | Select-Object -First 1
  $maxMae = ($judged | Measure-Object -Property mae -Maximum).Maximum
  $maxChanged = ($judged | Measure-Object -Property changed_pixel_ratio -Maximum).Maximum
  $flowedLines = if ($flowedRows.Count) { $flowedRows.Count } else { 0 }
  if ($flowedRows.Count -and -not $report.passed) { $failures += ("{0} (flowed block moved)" -f $name) }
  $rows += [pscustomobject]@{
    deck        = $name
    slides      = $judged.Count
    flowed      = [int]$flowedLines
    skipped     = [int]$report.skipped
    passed      = $report.passed
    min_ink     = [math]::Round($lowest.ink_iou, 3)
    worst_slide = $lowest.slide
    max_mae     = [math]::Round($maxMae, 4)
    max_changed = [math]::Round($maxChanged, 3)
  }
  if (-not $report.passed) {
    $failures += ("{0} (slide {1} ink {2})" -f $name, $lowest.slide, [math]::Round($lowest.ink_iou, 3))
  }
}
$rows | Format-Table -AutoSize | Out-String | Write-Host
if ($failures.Count) { Write-Error ("readers disagreed: " + ($failures -join ', ')); exit 1 }
Write-Host ("all {0} deck(s) agree across the two readers" -f $rows.Count)
exit 0
