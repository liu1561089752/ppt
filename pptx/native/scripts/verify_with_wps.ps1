# Open a generated deck in a second, independent OOXML consumer and report what it sees.
#
# Microsoft PowerPoint is not installed on the development machine, so this uses the
# PowerPoint-compatible COM surface that WPS Presentation (KWPP.Application) exposes. It
# is not PowerPoint, but it is a different reader from LibreOffice: a deck that opens
# here with the expected slide and shape counts is at least well-formed for a second
# commercial implementation.
#
# Usage:
#   pwsh -File scripts/verify_with_wps.ps1 -Deck deck.pptx [-ExpectedSlides 3]
# Prints one JSON object and exits non-zero when the deck cannot be opened or the counts
# disagree with what the caller expects.

param(
  [Parameter(Mandatory = $true)][string]$Deck,
  [int]$ExpectedSlides = -1,
  [string]$ExportDir = '',
  [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $Deck).Path
$result = [ordered]@{
  deck = $path
  opened = $false
  slides = 0
  shapes = @()
  characters = 0
  exports = @()
  error = $null
}

if ($ExportDir -ne '') {
  # The COM export resolves a relative path against the office application's own
  # working directory, so the folder is resolved once, here, before it is used.
  $ExportDir = (New-Item -ItemType Directory -Force -Path $ExportDir).FullName
}

$app = $null
$presentation = $null
try {
  $app = New-Object -ComObject KWPP.Application
  $presentation = $app.Presentations.Open($path, $true, $false, $false)
  $result.opened = $true
  $result.slides = [int]$presentation.Slides.Count
  foreach ($slide in $presentation.Slides) {
    $shapeCount = [int]$slide.Shapes.Count
    $textLength = 0
    foreach ($shape in $slide.Shapes) {
      try {
        if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
          $textLength += ([string]$shape.TextFrame.TextRange.Text).Length
        }
      } catch {
        # A shape without a text frame is not an error.
      }
    }
    $result.shapes += [ordered]@{ slide = [int]$slide.SlideIndex; shapes = $shapeCount; characters = $textLength }
    $result.characters += $textLength
    if ($ExportDir -ne '') {
      $target = Join-Path $ExportDir ('slide-{0:00}.png' -f [int]$slide.SlideIndex)
      $slide.Export($target, 'PNG', 1280, 720)
      $result.exports += $target
    }
  }
} catch {
  $result.error = $_.Exception.Message
} finally {
  if ($presentation -ne $null) {
    try { if (-not $KeepOpen) { $presentation.Close() } } catch { }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) } catch { }
  }
  if ($app -ne $null) {
    try { if (-not $KeepOpen) { $app.Quit() } } catch { }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
  }
  [GC]::Collect()
}

$result | ConvertTo-Json -Depth 5
if (-not $result.opened) { exit 1 }
if ($result.slides -lt 1) { exit 2 }
if ($ExpectedSlides -ge 0 -and $result.slides -ne $ExpectedSlides) {
  Write-Error "expected $ExpectedSlides slide(s), the reader found $($result.slides)"
  exit 3
}
foreach ($entry in $result.shapes) {
  if ($entry.shapes -lt 1) {
    Write-Error "slide $($entry.slide) opened with no shapes"
    exit 4
  }
}
exit 0
