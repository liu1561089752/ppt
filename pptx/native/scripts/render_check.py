#!/usr/bin/env python3
"""Render a generated PPTX with LibreOffice and verify the PDF/slide images exist.

Works with either toolchain:
  * `libreoffice`/`soffice` for the PDF, then `pdfinfo` + `pdftoppm` (poppler), or
  * `soffice` + `pypdfium2` when poppler is not installed.

soffice is found from $LIBREOFFICE_SOFFICE, then PATH (`libreoffice`, `soffice`),
then the usual install locations. Nothing is downloaded.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

SOFFICE_CANDIDATES = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
]


def run(command: list[str]) -> str:
    completed = subprocess.run(command, check=True, text=True, capture_output=True)
    return completed.stdout + completed.stderr


def find_soffice() -> str:
    configured = os.environ.get("LIBREOFFICE_SOFFICE")
    if configured and Path(configured).exists():
        return configured
    for name in ("libreoffice", "soffice", "soffice.exe"):
        found = shutil.which(name)
        if found:
            return found
    for candidate in SOFFICE_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    raise SystemExit(
        "LibreOffice not found: install it, put soffice on PATH, or set LIBREOFFICE_SOFFICE")


def poppler_page_count(pdf: Path) -> int | None:
    pdfinfo = shutil.which("pdfinfo")
    if not pdfinfo:
        return None
    match = re.search(r"^Pages:\s+(\d+)", run([pdfinfo, str(pdf)]), re.MULTILINE)
    return int(match.group(1)) if match else None


def pdfium_document(pdf: Path):
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return None
    return pdfium.PdfDocument(str(pdf))


def contiguous(pages: list[int]) -> list[tuple[int, int]]:
    """Page numbers as runs: `pdftoppm` takes a first and a last, not a list."""
    runs: list[tuple[int, int]] = []
    for page in pages:
        if runs and page == runs[-1][1] + 1:
            runs[-1] = (runs[-1][0], page)
        else:
            runs.append((page, page))
    return runs


def render_with_poppler(pdf: Path, prefix: Path, pages: list[int] | None = None) -> list[Path]:
    if pages is None:
        run(["pdftoppm", "-png", "-r", "120", str(pdf), str(prefix)])
    else:
        for first, last in contiguous(pages):
            run(["pdftoppm", "-png", "-r", "120", "-f", str(first), "-l", str(last),
                 str(pdf), str(prefix)])
    return sorted(prefix.parent.glob(prefix.name + "-*.png"))


def render_with_pdfium(document, prefix: Path, pages: list[int] | None = None) -> list[Path]:
    written = []
    for index in (range(len(document)) if pages is None else [page - 1 for page in pages]):
        page = document[index]
        bitmap = page.render(scale=2.0)
        try:
            image = bitmap.to_pil()
        finally:
            bitmap.close()
        target = prefix.parent / f"{prefix.name}-{index + 1:02d}.png"
        image.save(target)
        written.append(target)
        page.close()
    return written


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("render-check"))
    parser.add_argument(
        "--slides", default=None,
        help="render only these pages, e.g. `3` or `1,4-6`; the PDF is still exported whole, "
             "so this saves the raster, not the conversion")
    args = parser.parse_args()

    source = args.pptx.resolve()
    if not source.is_file():
        raise SystemExit(f"Input PPTX not found: {source}")

    with zipfile.ZipFile(source) as archive:
        slide_xml = [
            name for name in archive.namelist()
            if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
        ]
        if not slide_xml:
            raise SystemExit("PPTX contains no slide XML parts")
        expected_pages = len(slide_xml)
        bad_member = archive.testzip()
        if bad_member:
            raise SystemExit(f"Corrupt ZIP member: {bad_member}")

    pages = None
    if args.slides:
        pages = []
        for part in args.slides.split(","):
            part = part.strip()
            if not part:
                continue
            if "-" in part:
                first, last = (int(value) for value in part.split("-", 1))
                pages.extend(range(min(first, last), max(first, last) + 1))
            else:
                pages.append(int(part))
        pages = sorted(set(pages))
        if not pages:
            raise SystemExit("--slides selected no page")
        beyond = [page for page in pages if page < 1 or page > expected_pages]
        if beyond:
            raise SystemExit(
                f"--slides asks for page {beyond[0]}, but the deck has {expected_pages}"
            )
    wanted = len(pages) if pages is not None else expected_pages

    args.output_dir.mkdir(parents=True, exist_ok=True)
    soffice = find_soffice()

    with tempfile.TemporaryDirectory(prefix="native-ppt-render-") as temp:
        temp_dir = Path(temp)
        run([
            soffice, "--headless", "--norestore", "--convert-to", "pdf",
            "--outdir", str(temp_dir), str(source)
        ])
        pdf = temp_dir / (source.stem + ".pdf")
        if not pdf.is_file() or pdf.stat().st_size == 0:
            raise SystemExit("LibreOffice did not produce a non-empty PDF")

        rendered_pages = poppler_page_count(pdf)
        document = None
        if rendered_pages is None:
            document = pdfium_document(pdf)
            if document is not None:
                rendered_pages = len(document)
        if rendered_pages is None:
            raise SystemExit(
                "Cannot count PDF pages: install poppler (pdfinfo) or pypdfium2 "
                "(pip install pypdfium2)")
        if rendered_pages != expected_pages:
            raise SystemExit(
                f"Slide count mismatch: PPTX={expected_pages}, PDF={rendered_pages}"
            )

        target_pdf = args.output_dir / (source.stem + ".pdf")
        target_pdf.write_bytes(pdf.read_bytes())
        prefix = args.output_dir / (source.stem + "-slide")
        if shutil.which("pdftoppm"):
            images = render_with_poppler(pdf, prefix, pages)
        else:
            if document is None:
                document = pdfium_document(pdf)
            if document is None:
                raise SystemExit(
                    "Cannot rasterise the PDF: install poppler (pdftoppm) or pypdfium2")
            images = render_with_pdfium(document, prefix, pages)
        if len(images) != wanted:
            raise SystemExit(
                f"Expected {wanted} rendered slide images, found {len(images)}"
            )
        if document is not None:
            # pypdfium2 finalisers are order dependent; closing explicitly avoids
            # "Set changed size during iteration" at interpreter shutdown.
            document.close()

    if pages is None:
        print(f"Rendered and verified {expected_pages} slides from {source.name}")
    else:
        listed = ",".join(str(page) for page in pages)
        print(f"Rendered and verified {wanted} of {expected_pages} slides "
              f"(pages {listed}) from {source.name}")
    print(f"PDF and PNG previews: {args.output_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
