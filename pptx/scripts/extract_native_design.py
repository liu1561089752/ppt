#!/usr/bin/env python3
"""Extract a reusable native-PPT design profile from a reference presentation.

Outputs design tokens, page dimensions, font usage, recurring shape signatures,
and per-slide geometry patterns. Uses only the Python standard library.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}

EMU_PER_INCH = 914400


def tag_name(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def read_color(element: ET.Element) -> str | None:
    for child in element.iter():
        name = tag_name(child)
        if name == "srgbClr" and child.get("val"):
            return "#" + child.get("val").upper()
        if name == "sysClr":
            value = child.get("lastClr")
            if value:
                return "#" + value.upper()
    return None


def read_theme(xml: bytes) -> dict:
    root = ET.fromstring(xml)
    palette: dict[str, str] = {}
    fonts: dict[str, str] = {}
    scheme = root.find(".//a:clrScheme", NS)
    if scheme is not None:
        for slot in ("dk1", "lt1", "dk2", "lt2", "accent1", "accent2",
                     "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"):
            node = scheme.find("a:" + slot, NS)
            if node is not None:
                color = read_color(node)
                if color:
                    palette[slot] = color
    font_scheme = root.find(".//a:fontScheme", NS)
    if font_scheme is not None:
        for group, prefix in (("majorFont", "heading"), ("minorFont", "body")):
            for script, suffix in (("latin", ""), ("ea", "_ea"), ("cs", "_complex")):
                node = font_scheme.find("a:" + group + "/a:" + script, NS)
                if node is not None and node.get("typeface"):
                    fonts[prefix + suffix] = node.get("typeface")
    return {"palette": palette, "fonts": fonts}


def read_page_size(xml: bytes) -> dict:
    root = ET.fromstring(xml)
    size = root.find(".//p:sldSz", NS)
    if size is None:
        return {"width_in": 13.333, "height_in": 7.5, "source": "default"}
    width = int(size.get("cx", "0")) / EMU_PER_INCH
    height = int(size.get("cy", "0")) / EMU_PER_INCH
    return {"width_in": round(width, 4), "height_in": round(height, 4), "source": "ppt/presentation.xml"}


def get_transform(element: ET.Element) -> tuple[float, float, float, float] | None:
    transform = element.find(".//a:xfrm", NS)
    if transform is None:
        transform = element.find("p:xfrm", NS)
    if transform is None:
        return None
    offset = transform.find("a:off", NS)
    extent = transform.find("a:ext", NS)
    if offset is None or extent is None:
        return None
    try:
        x = int(offset.get("x", "0")) / EMU_PER_INCH
        y = int(offset.get("y", "0")) / EMU_PER_INCH
        w = int(extent.get("cx", "0")) / EMU_PER_INCH
        h = int(extent.get("cy", "0")) / EMU_PER_INCH
    except ValueError:
        return None
    return x, y, w, h


def extract_slide(xml: bytes, slide_number: int, page_size: dict) -> dict:
    root = ET.fromstring(xml)
    colors = collections.Counter()
    fonts = collections.Counter()
    east_asian_fonts = collections.Counter()
    sizes = collections.Counter()
    shapes = collections.Counter()
    elements: list[dict] = []

    for node in root.findall(".//p:spTree/*", NS):
        kind = tag_name(node)
        if kind not in {"sp", "pic", "graphicFrame", "cxnSp"}:
            continue
        geometry = get_transform(node)
        text = "".join(part.text or "" for part in node.findall(".//a:t", NS))
        preset = node.find(".//a:prstGeom", NS)
        shape_type = preset.get("prst") if preset is not None else kind
        fill = read_color(node.find(".//a:solidFill", NS)) if node.find(".//a:solidFill", NS) is not None else None

        run_sizes: list[float] = []
        for prop in list(node.iter()):
            if tag_name(prop) not in {"rPr", "defRPr", "endParaRPr"}:
                continue
            raw_size = prop.get("sz")
            if raw_size:
                try:
                    size = int(raw_size) / 100
                    sizes[size] += 1
                    run_sizes.append(size)
                except ValueError:
                    pass
            for child in prop:
                if tag_name(child) == "latin" and child.get("typeface"):
                    fonts[child.get("typeface")] += 1
                elif tag_name(child) == "ea" and child.get("typeface"):
                    east_asian_fonts[child.get("typeface")] += 1

        for color_node in node.iter():
            if tag_name(color_node) == "srgbClr" and color_node.get("val"):
                colors["#" + color_node.get("val").upper()] += 1

        shapes[shape_type] += 1
        record = {
            "kind": kind,
            "shape_type": shape_type,
            "text": text[:180],
            "fill": fill,
            "font_sizes_pt": sorted(set(run_sizes)),
        }
        if geometry:
            x, y, w, h = geometry
            page_w = page_size["width_in"] or 1
            page_h = page_size["height_in"] or 1
            record["geometry_in"] = {
                "x": round(x, 3), "y": round(y, 3),
                "w": round(w, 3), "h": round(h, 3),
            }
            record["geometry_ratio"] = {
                "x": round(x / page_w, 4), "y": round(y / page_h, 4),
                "w": round(w / page_w, 4), "h": round(h / page_h, 4),
            }
        elements.append(record)

    return {
        "slide": slide_number,
        "element_count": len(elements),
        "shape_types": shapes.most_common(),
        "top_colors": colors.most_common(12),
        "top_fonts": fonts.most_common(8),
        "top_east_asian_fonts": east_asian_fonts.most_common(8),
        "font_sizes_pt": sizes.most_common(12),
        "elements": elements,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx_path", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    if not args.pptx_path.is_file() or args.pptx_path.suffix.lower() != ".pptx":
        parser.error("pptx_path must point to an existing .pptx file")

    with zipfile.ZipFile(args.pptx_path) as archive:
        names = archive.namelist()
        theme_names = sorted(name for name in names if re.fullmatch(r"ppt/theme/theme\d+\.xml", name))
        if not theme_names:
            parser.error("No theme XML found in PPTX")
        presentation_xml = archive.read("ppt/presentation.xml")
        theme = read_theme(archive.read(theme_names[0]))
        page_size = read_page_size(presentation_xml)
        slide_names = sorted(
            (name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
            key=lambda name: int(re.search(r"slide(\d+)\.xml", name).group(1)),
        )
        slides = [
            extract_slide(archive.read(name), int(re.search(r"slide(\d+)\.xml", name).group(1)), page_size)
            for name in slide_names
        ]
        master_count = len([name for name in names if re.fullmatch(r"ppt/slideMasters/slideMaster\d+\.xml", name)])
        layout_count = len([name for name in names if re.fullmatch(r"ppt/slideLayouts/slideLayout\d+\.xml", name)])

    all_colors = collections.Counter()
    all_fonts = collections.Counter()
    all_ea_fonts = collections.Counter()
    all_sizes = collections.Counter()
    all_shapes = collections.Counter()
    signatures = collections.Counter()
    for slide in slides:
        all_colors.update(dict(slide["top_colors"]))
        all_fonts.update(dict(slide["top_fonts"]))
        all_ea_fonts.update(dict(slide["top_east_asian_fonts"]))
        all_sizes.update(dict(slide["font_sizes_pt"]))
        all_shapes.update(dict(slide["shape_types"]))
        for element in slide["elements"]:
            geometry = element.get("geometry_in")
            if geometry:
                signature = (
                    element["kind"], element["shape_type"],
                    round(geometry["w"], 2), round(geometry["h"], 2),
                )
                signatures[signature] += 1

    palette = theme["palette"]
    design = {
        "source_pptx": str(args.pptx_path.resolve()),
        "page_size": page_size,
        "slide_count": len(slides),
        "master_count": master_count,
        "layout_count": layout_count,
        "theme": theme,
        "design_tokens": {
            "background": palette.get("lt1") or palette.get("lt2") or "#FFFFFF",
            "foreground": palette.get("dk1") or palette.get("dk2") or "#202321",
            "primary": palette.get("accent1") or palette.get("dk2") or "#183B3A",
            "accent": palette.get("accent2") or palette.get("accent1") or "#D36B45",
            "heading_font": theme["fonts"].get("heading"),
            "body_font": theme["fonts"].get("body"),
            "east_asian_heading_font": theme["fonts"].get("heading_ea"),
            "east_asian_body_font": theme["fonts"].get("body_ea"),
        },
        "observed_usage": {
            "colors": all_colors.most_common(16),
            "fonts": all_fonts.most_common(12),
            "east_asian_fonts": all_ea_fonts.most_common(12),
            "font_sizes_pt": all_sizes.most_common(16),
            "shape_types": all_shapes.most_common(16),
        },
    }

    layout_patterns = {
        "page_size": page_size,
        "slides": [
            {
                "slide": slide["slide"],
                "element_count": slide["element_count"],
                "elements": slide["elements"],
            }
            for slide in slides
        ],
    }
    component_patterns = {
        "shape_type_frequency": all_shapes.most_common(),
        "repeated_geometry_signatures": [
            {"kind": key[0], "shape_type": key[1], "width_in": key[2], "height_in": key[3], "count": count}
            for key, count in signatures.most_common(40)
        ],
        "common_font_sizes_pt": all_sizes.most_common(16),
        "common_fill_colors": all_colors.most_common(16),
    }
    font_config = {
        "theme_fonts": theme["fonts"],
        "observed_latin_fonts": all_fonts.most_common(),
        "observed_east_asian_fonts": all_ea_fonts.most_common(),
        "observed_sizes_pt": all_sizes.most_common(),
        "note": "Font names are references only; target machines must have compatible fonts installed.",
    }

    args.output_dir.mkdir(parents=True, exist_ok=True)
    outputs = {
        "design.json": design,
        "layout_patterns.json": layout_patterns,
        "component_patterns.json": component_patterns,
        "font_config.json": font_config,
    }
    for filename, payload in outputs.items():
        (args.output_dir / filename).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print("wrote", args.output_dir / filename)

    print(f"analysed {len(slides)} slides; page={page_size['width_in']} x {page_size['height_in']} in")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
