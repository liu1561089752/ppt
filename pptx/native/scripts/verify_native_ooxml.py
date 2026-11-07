#!/usr/bin/env python3
"""Assert that a generated PPTX contains requested editable DrawingML features."""
from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
}


def inspect(path: Path) -> dict[str, int]:
    counts = {"slides": 0, "shapes": 0, "texts": 0, "gradients": 0,
              "shadows": 0, "alpha_nodes": 0, "charts": 0, "pictures": 0}
    with zipfile.ZipFile(path) as archive:
        slide_names = sorted(
            (name for name in archive.namelist()
             if name.startswith("ppt/slides/slide") and name.endswith(".xml")
             and "/_rels/" not in name),
            key=lambda name: int(name.rsplit("slide", 1)[1].split(".")[0])
        )
        counts["slides"] = len(slide_names)
        for name in slide_names:
            root = ET.fromstring(archive.read(name))
            counts["shapes"] += len(root.findall(".//p:sp", NS))
            counts["texts"] += len(root.findall(".//p:sp[p:txBody]", NS))
            counts["gradients"] += len(root.findall(".//a:gradFill", NS))
            counts["shadows"] += len(root.findall(".//a:outerShdw", NS))
            counts["alpha_nodes"] += len(root.findall(".//a:alpha", NS))
            counts["charts"] += len(root.findall(".//p:graphicFrame", NS))
            counts["pictures"] += len(root.findall(".//p:pic", NS))
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--require-gradient", action="store_true")
    parser.add_argument("--require-shadow", action="store_true")
    parser.add_argument("--require-alpha", action="store_true")
    args = parser.parse_args()
    if not args.pptx.is_file():
        parser.error(f"PPTX not found: {args.pptx}")
    counts = inspect(args.pptx)
    print(json.dumps(counts, ensure_ascii=False, indent=2))
    requirements = {
        "gradient": (args.require_gradient, counts["gradients"]),
        "shadow": (args.require_shadow, counts["shadows"]),
        "alpha": (args.require_alpha, counts["alpha_nodes"]),
    }
    missing = [name for name, (required, count) in requirements.items() if required and count < 1]
    if missing:
        raise SystemExit("Missing required editable OOXML features: " + ", ".join(missing))
    if counts["slides"] < 1:
        raise SystemExit("PPTX contains no slide XML parts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
