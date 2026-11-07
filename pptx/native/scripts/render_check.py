#!/usr/bin/env python3
"""Render a generated PPTX with LibreOffice and verify the PDF/slide images exist."""

from __future__ import annotations

import argparse
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path


def run(command: list[str]) -> str:
    completed = subprocess.run(command, check=True, text=True, capture_output=True)
    return completed.stdout + completed.stderr


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("render-check"))
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

    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="native-ppt-render-") as temp:
        temp_dir = Path(temp)
        run([
            "libreoffice", "--headless", "--convert-to", "pdf",
            "--outdir", str(temp_dir), str(source)
        ])
        pdf = temp_dir / (source.stem + ".pdf")
        if not pdf.is_file() or pdf.stat().st_size == 0:
            raise SystemExit("LibreOffice did not produce a non-empty PDF")
        info = run(["pdfinfo", str(pdf)])
        page_match = re.search(r"^Pages:\s+(\d+)", info, re.MULTILINE)
        if not page_match:
            raise SystemExit("Could not read page count from pdfinfo")
        rendered_pages = int(page_match.group(1))
        if rendered_pages != expected_pages:
            raise SystemExit(
                f"Slide count mismatch: PPTX={expected_pages}, PDF={rendered_pages}"
            )
        target_pdf = args.output_dir / (source.stem + ".pdf")
        target_pdf.write_bytes(pdf.read_bytes())
        prefix = args.output_dir / (source.stem + "-slide")
        run(["pdftoppm", "-png", "-r", "120", str(pdf), str(prefix)])
        images = sorted(args.output_dir.glob(source.stem + "-slide-*.png"))
        if len(images) != expected_pages:
            raise SystemExit(
                f"Expected {expected_pages} rendered slide images, found {len(images)}"
            )

    print(f"Rendered and verified {expected_pages} slides from {source.name}")
    print(f"PDF and PNG previews: {args.output_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
