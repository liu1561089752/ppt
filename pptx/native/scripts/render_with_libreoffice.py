#!/usr/bin/env python3
"""Render a PPTX through LibreOffice (soffice → PDF → PNG) for real inspection.

This is the *real renderer* path: LibreOffice's Impress engine lays out the deck
the way a presentation application does, so it confirms what the offline
Pillow preview can only approximate (text shaping, gradient stops, native
charts, rotation, merged table cells).

Requires LibreOffice (soffice) and pypdfium2:

    python scripts/render_with_libreoffice.py deck.pptx --output-dir render/deck
    python scripts/render_with_libreoffice.py deck.pptx --soffice "C:\\path\\soffice.exe"

soffice is located from --soffice, then $LIBREOFFICE_SOFFICE, then PATH, then the
usual Windows/macOS install locations. Nothing is downloaded automatically.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CANDIDATE_SOFFICE = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
]


def find_soffice(explicit: str | None) -> str | None:
    if explicit:
        return explicit if Path(explicit).exists() else None
    from_env = os.environ.get("LIBREOFFICE_SOFFICE")
    if from_env and Path(from_env).exists():
        return from_env
    on_path = shutil.which("soffice") or shutil.which("soffice.exe")
    if on_path:
        return on_path
    for candidate in CANDIDATE_SOFFICE:
        if Path(candidate).exists():
            return candidate
    return None


def convert_to_pdf(soffice: str, pptx: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [soffice, "--headless", "--norestore", "--convert-to", "pdf",
         "--outdir", str(out_dir), str(pptx)],
        capture_output=True, text=True, timeout=600, check=False,
    )
    pdf = out_dir / (pptx.stem + ".pdf")
    if not pdf.exists():
        detail = (result.stderr or result.stdout or "").strip().splitlines()[:4]
        raise SystemExit("LibreOffice did not produce a PDF for " + pptx.name + "\n  " + "\n  ".join(detail))
    return pdf


def rasterize(pdf: Path, out_dir: Path, width_px: int) -> list[Path]:
    try:
        import pypdfium2 as pdfium
    except ImportError:  # pragma: no cover - dependency is optional
        raise SystemExit("pypdfium2 is required to rasterise the PDF: pip install pypdfium2")
    document = pdfium.PdfDocument(str(pdf))
    written = []
    for index in range(len(document)):
        page = document[index]
        page_width = page.get_width() or 1
        scale = max(0.5, width_px / float(page_width))
        image = page.render(scale=scale).to_pil()
        target = out_dir / f"slide-{index + 1:02d}.png"
        image.save(target)
        written.append(target)
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("render"))
    parser.add_argument("--soffice", default=None)
    parser.add_argument("--width", type=int, default=1280, help="raster width in pixels")
    parser.add_argument("--keep-pdf", action="store_true", help="keep the intermediate PDF")
    args = parser.parse_args()

    if not args.pptx.exists():
        raise SystemExit("missing deck: " + str(args.pptx))
    soffice = find_soffice(args.soffice)
    if not soffice:
        raise SystemExit(
            "LibreOffice (soffice) was not found. Pass --soffice, set LIBREOFFICE_SOFFICE, "
            "or install LibreOffice; no network download is attempted.")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    pdf_dir = args.output_dir if args.keep_pdf else Path(tempfile.mkdtemp(prefix="deck-pdf-"))
    pdf = convert_to_pdf(soffice, args.pptx, pdf_dir)
    images = rasterize(pdf, args.output_dir, args.width)
    if not args.keep_pdf:
        shutil.rmtree(pdf_dir, ignore_errors=True)
    print(f"rendered {len(images)} slide(s) with LibreOffice into {args.output_dir}")
    for image in images:
        print("  " + image.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
