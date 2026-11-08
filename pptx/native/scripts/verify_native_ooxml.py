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
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
}


def inspect(path: Path) -> dict[str, int]:
    counts = {"slides": 0, "shapes": 0, "texts": 0, "gradients": 0,
              "shadows": 0, "alpha_nodes": 0, "charts": 0, "pictures": 0,
              "image_crops": 0, "rounded_pictures": 0, "outlined_pictures": 0,
              "shadowed_pictures": 0, "tables": 0}
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
            for frame in root.findall(".//p:graphicFrame", NS):
                if frame.findall(".//c:chart", NS):
                    counts["charts"] += 1
            counts["tables"] += len(root.findall(".//a:tbl", NS))
            pictures = root.findall(".//p:pic", NS)
            counts["pictures"] += len(pictures)
            for picture in pictures:
                if picture.findall(".//a:srcRect", NS):
                    counts["image_crops"] += 1
                geometry = picture.find(".//a:prstGeom", NS)
                if geometry is not None and geometry.get("prst") == "roundRect":
                    counts["rounded_pictures"] += 1
                if picture.findall(".//a:ln", NS):
                    counts["outlined_pictures"] += 1
                if picture.findall(".//a:effectLst", NS):
                    counts["shadowed_pictures"] += 1
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--require-gradient", action="store_true")
    parser.add_argument("--require-shadow", action="store_true")
    parser.add_argument("--require-alpha", action="store_true")
    parser.add_argument("--require-image-crop", action="store_true")
    parser.add_argument("--require-picture-effects", action="store_true")
    parser.add_argument("--require-table", action="store_true")
    args = parser.parse_args()
    if not args.pptx.is_file():
        parser.error(f"PPTX not found: {args.pptx}")
    counts = inspect(args.pptx)
    print(json.dumps(counts, ensure_ascii=False, indent=2))
    requirements = {
        "gradient": (args.require_gradient, counts["gradients"]),
        "shadow": (args.require_shadow, counts["shadows"]),
        "alpha": (args.require_alpha, counts["alpha_nodes"]),
        "image crop": (args.require_image_crop, counts["image_crops"]),
        "picture effects": (args.require_picture_effects,
                            counts["rounded_pictures"] + counts["outlined_pictures"] + counts["shadowed_pictures"]),
        "table": (args.require_table, counts["tables"]),
    }
    missing = [name for name, (required, count) in requirements.items() if required and count < 1]
    if missing:
        raise SystemExit("Missing required editable OOXML features: " + ", ".join(missing))
    if counts["slides"] < 1:
        raise SystemExit("PPTX contains no slide XML parts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
