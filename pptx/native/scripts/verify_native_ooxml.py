#!/usr/bin/env python3
"""Assert that a generated PPTX contains requested editable DrawingML features."""
from __future__ import annotations

import argparse
import json
import posixpath
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
}

# Attributes whose value comes from an enumerated type. A value outside the set is not
# "slightly wrong": PowerPoint treats the file as damaged, so it is a hard failure.
ENUM_VALUES = {
    ("bodyPr", "anchor"): {"t", "ctr", "b", "just", "dist"},
    ("tcPr", "anchor"): {"t", "ctr", "b", "just", "dist"},
    ("bodyPr", "vert"): {"horz", "vert", "vert270", "wordArtVert", "eaVert",
                         "mongolianVert", "wordArtVertRtl"},
    ("pPr", "algn"): {"l", "ctr", "r", "just", "dist", "thaiDist", "justLow"},
    ("legendPos", "val"): {"t", "b", "l", "r", "tr"},
    ("barDir", "val"): {"bar", "col"},
    ("grouping", "val"): {"standard", "stacked", "percentStacked", "clustered"},
    ("dLblPos", "val"): {"bestFit", "b", "ctr", "inBase", "inEnd", "l", "outEnd", "r", "t"},
}


REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
R_ID_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
R_ATTRS = {"id", "embed", "link", "pict"}


# The schema is a sequence, not a set. PowerPoint enforces the order of these children
# and answers a swapped pair with an offer to repair the file; a renderer that reads
# children by name does not care, so the order has to be checked here.
# Each entry is the ordered list of slots a container allows; a slot may hold one of
# several alternatives, which is how the fill and the bullet groups work.
CHILD_ORDER = {
    "spPr": [["xfrm"], ["custGeom", "prstGeom"], ["noFill", "solidFill", "gradFill",
                                       "blipFill", "pattFill", "grpFill"],
              ["ln"], ["effectLst", "effectDag"], ["scene3d"], ["sp3d"], ["extLst"]],
    "rPr": [["ln"], ["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"],
             ["effectLst", "effectDag"], ["highlight"], ["uLnTx", "uLn"],
             ["uFillTx", "uFill"], ["latin"], ["ea"], ["cs"], ["sym"],
             ["hlinkClick"], ["hlinkMouseOver"], ["rtl"], ["extLst"]],
    "pPr": [["lnSpc"], ["spcBef"], ["spcAft"], ["buClrTx", "buClr"],
             ["buSzTx", "buSzPct", "buSzPts"], ["buFontTx", "buFont"],
             ["buNone", "buAutoNum", "buChar", "buBlip"], ["tabLst"], ["defRPr"], ["extLst"]],
    "bodyPr": [["prstTxWarp"], ["noAutofit", "normAutofit", "spAutoFit"],
                ["scene3d"], ["sp3d"], ["flatTx"], ["extLst"]],
    "tcPr": [["lnL"], ["lnR"], ["lnT"], ["lnB"], ["lnTlToBr"], ["lnBlToTr"],
              ["cell3D"], ["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"],
              ["headers"], ["extLst"]],
    "ln": [["noFill", "solidFill", "gradFill", "pattFill"], ["prstDash", "custDash"],
           ["round", "bevel", "miter"], ["headEnd"], ["tailEnd"], ["extLst"]],
}


def audit_child_order(root: ET.Element) -> list[str]:
    """Every container the writer patches, checked against its schema sequence."""
    problems: list[str] = []
    for element in root.iter():
        container = local_name(element.tag)
        slots = CHILD_ORDER.get(container)
        if slots is None:
            continue
        reached = -1
        for child in list(element):
            name = local_name(child.tag)
            index = next((position for position, slot in enumerate(slots) if name in slot), None)
            if index is None:
                problems.append(f"<{container}> holds <{name}>, which the schema does not allow there")
                continue
            if index < reached:
                problems.append(f"<{container}> puts <{name}> after a later slot")
            reached = max(reached, index)
    return problems

def audit_integrity(path: Path) -> list[str]:
    """Package-level checks a reader runs before it draws anything.

    Three things make PowerPoint offer to repair a file, and none of them show up in
    a render: a shape id used twice in one slide, a relationship pointing at a part
    that is not there, and a part no content type covers. They are cheap to check and
    they are exactly the failures a renderer with a forgiving parser hides.
    """
    problems: list[str] = []
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        media = {name for name in names if not name.endswith("/")}

        # 1. Every part is typed: an Override for it, or a Default for its extension.
        try:
            types = ET.fromstring(archive.read("[Content_Types].xml"))
        except (KeyError, ET.ParseError) as error:
            return ["[Content_Types].xml is missing or unreadable: " + str(error)]
        defaults = {node.get("Extension", "").lower() for node in types.findall("{" + CT_NS + "}Default")}
        overrides = {node.get("PartName", "").lstrip("/") for node in types.findall("{" + CT_NS + "}Override")}
        for name in sorted(media):
            if name == "[Content_Types].xml":
                continue
            if name in overrides:
                continue
            extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            if extension in defaults:
                continue
            problems.append(f"part {name} has no content type")

        # 2. Every relationship resolves to a part that exists.
        for name in sorted(media):
            if not name.endswith(".rels"):
                continue
            folder = name.rsplit("/_rels/", 1)[0] if "/_rels/" in name else ""
            try:
                rels = ET.fromstring(archive.read(name))
            except ET.ParseError as error:
                problems.append(f"{name} is not readable XML: {error}")
                continue
            for rel in rels.findall("{" + REL_NS + "}Relationship"):
                if rel.get("TargetMode") == "External":
                    continue
                target = rel.get("Target", "")
                if target.startswith("/"):
                    resolved = target.lstrip("/")
                else:
                    resolved = posixpath.normpath(posixpath.join(folder, target)) if folder else posixpath.normpath(target)
                if resolved not in media:
                    problems.append(f"{name} points at a missing part: {target}")

        # 3. A slide's shape ids are unique, and every r:id/r:embed it uses is declared.
        for name in sorted(media):
            if not (name.startswith("ppt/slides/slide") or name.startswith("ppt/charts/chart")) \
                    or not name.endswith(".xml") or "/_rels/" in name:
                continue
            try:
                root = ET.fromstring(archive.read(name))
            except ET.ParseError as error:
                problems.append(f"{name} is not readable XML: {error}")
                continue
            seen: dict[str, int] = {}
            for element in root.iter():
                if local_name(element.tag) not in ("cNvPr", "cNvGraphicFramePr"):
                    continue
                identifier = element.get("id")
                if identifier is None:
                    continue
                seen[identifier] = seen.get(identifier, 0) + 1
            for identifier, count in seen.items():
                if count > 1:
                    problems.append(f"{name} uses shape id {identifier} {count} times")
                elif not identifier.isdigit() or int(identifier) < 1:
                    problems.append(f"{name} has shape id {identifier!r}, which is not a positive integer")
            declared = relationship_ids(archive, name)
            for element in root.iter():
                for attribute, value in element.attrib.items():
                    if not attribute.startswith("{" + R_ID_NS + "}"):
                        continue
                    if local_name(attribute) not in R_ATTRS:
                        continue
                    if value not in declared:
                        problems.append(f"{name} uses relationship {value} that its rels does not declare")
    return problems


def relationship_ids(archive: zipfile.ZipFile, part: str) -> set[str]:
    """The ids a part's own rels file declares."""
    folder, _, base = part.rpartition("/")
    rels_name = (folder + "/" if folder else "") + "_rels/" + base + ".rels"
    try:
        root = ET.fromstring(archive.read(rels_name))
    except (KeyError, ET.ParseError):
        return set()
    return {rel.get("Id") for rel in root.findall("{" + REL_NS + "}Relationship")}



def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def audit_enums(root: ET.Element) -> list[str]:
    """Every enumerated attribute we write, checked against the schema's value set."""
    problems: list[str] = []
    for element in root.iter():
        name = local_name(element.tag)
        for (expected, attribute), allowed in ENUM_VALUES.items():
            if name != expected:
                continue
            value = element.get(attribute)
            if value is not None and value not in allowed:
                problems.append(f"<{name} {attribute}=\"{value}\"> is not one of "
                                + "/".join(sorted(allowed)))
    return problems


def inspect(path: Path) -> dict[str, int]:
    # `path` is reused below for geometry path elements; the file is kept under its own name.
    package_path = path
    counts = {"slides": 0, "shapes": 0, "texts": 0, "gradients": 0,
              "shadows": 0, "alpha_nodes": 0, "charts": 0, "pictures": 0,
              "image_crops": 0, "rounded_pictures": 0, "outlined_pictures": 0,
              "shadowed_pictures": 0, "tables": 0,
              "merged_cells": 0, "uneven_tables": 0, "rotated": 0,
              "text_columns": 0, "small_caps": 0, "custom_geometry": 0,
              "invalid_enums": 0}
    problems: list[str] = []
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
            problems.extend(audit_enums(root))
            problems.extend(audit_child_order(root))
            counts["shapes"] += len(root.findall(".//p:sp", NS))
            # A rotation is an xfrm attribute; 0 means "not rotated".
            for rotation in root.findall(".//a:xfrm", NS):
                value = rotation.get("rot")
                if value is not None and int(value) != 0:
                    counts["rotated"] += 1
            counts["texts"] += len(root.findall(".//p:sp[p:txBody]", NS))
            # `numCol` is how DrawingML spells a columned text box; the writer has no option
            # for it, so it is patched in and has to be checked like any other attribute.
            for body in root.findall(".//a:bodyPr", NS):
                declared = body.get("numCol")
                if declared is None:
                    continue
                counts["text_columns"] += 1
                try:
                    columns = int(declared)
                except ValueError:
                    problems.append(f'<a:bodyPr numCol="{declared}"> is not an integer')
                    continue
                if not 1 <= columns <= 16:
                    problems.append(f'<a:bodyPr numCol="{declared}"> is outside 1..16')
                spacing = body.get("spcCol")
                if spacing is not None:
                    try:
                        if int(spacing) < 0:
                            problems.append(f'<a:bodyPr spcCol="{spacing}"> is negative')
                    except ValueError:
                        problems.append(f'<a:bodyPr spcCol="{spacing}"> is not an integer')
            # A `clip-path: polygon()` becomes a custom geometry; a path with fewer than
            # three points or no close is a shape a reader will draw wrong.
            for geometry in root.findall(".//a:custGeom", NS):
                counts["custom_geometry"] += 1
                paths = geometry.findall(".//a:path", NS)
                if not paths:
                    problems.append("<a:custGeom> has no <a:path>")
                    continue
                for path in paths:
                    points = path.findall(".//a:pt", NS)
                    if len(points) < 3:
                        problems.append(f"<a:custGeom> path has {len(points)} point(s)")
                    if path.find("a:close", NS) is None:
                        problems.append("<a:custGeom> path is not closed")
            for run in root.findall(".//a:rPr", NS):
                cap = run.get("cap")
                if cap is None:
                    continue
                counts["small_caps"] += 1
                if cap not in ("none", "small", "all"):
                    problems.append(f'<a:rPr cap="{cap}"> is not none/small/all')
            counts["gradients"] += len(root.findall(".//a:gradFill", NS))
            counts["shadows"] += len(root.findall(".//a:outerShdw", NS))
            counts["alpha_nodes"] += len(root.findall(".//a:alpha", NS))
            for frame in root.findall(".//p:graphicFrame", NS):
                if frame.findall(".//c:chart", NS):
                    counts["charts"] += 1
            counts["tables"] += len(root.findall(".//a:tbl", NS))
            for table in root.findall(".//a:tbl", NS):
                # Merged cells are attributes on <a:tc>, not child elements.
                for cell in table.findall(".//a:tc", NS):
                    if cell.get("gridSpan") or cell.get("rowSpan"):
                        counts["merged_cells"] += 1
                widths = [column.get("w") for column in table.findall(".//a:gridCol", NS)]
                if widths and len(set(widths)) > 1:
                    counts["uneven_tables"] += 1
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
        chart_names = [name for name in archive.namelist()
                       if name.startswith("ppt/charts/chart") and name.endswith(".xml")
                       and "/_rels/" not in name]
        for name in chart_names:
            chart_root = ET.fromstring(archive.read(name))
            problems.extend(audit_enums(chart_root))
            problems.extend(audit_child_order(chart_root))
    # The package-level checks run on every invocation: a file a reader offers to repair
    # is broken even when the render looks right.
    integrity = audit_integrity(package_path)
    counts["integrity_problems"] = len(integrity)
    if integrity:
        counts["_integrity_examples"] = integrity[:5]  # noqa: PLC0206 - report, then fail
    counts["invalid_enums"] = len(problems)
    if problems:
        counts["_problem_examples"] = problems[:5]  # noqa: PLC0206 - report, then fail
    return counts


def self_test() -> int:
    """Prove the checks still fire, on XML written to fail them.

    A gate that never fires is worse than no gate, so each control is a document the
    check has to reject - including the invented element that shipped before the
    ordering check existed."""
    drawing = "http://schemas.openxmlformats.org/drawingml/2006/main"
    controls = [
        ("a good pPr", "<a:pPr><a:spcBef/><a:buChar char='x'/><a:defRPr/></a:pPr>", False),
        ("a bullet before its spacing", "<a:pPr><a:buChar char='x'/><a:spcBef/></a:pPr>", True),
        ("a line after the fill", "<a:rPr><a:solidFill/><a:ln/></a:rPr>", True),
        ("an invented element", "<a:rPr><a:emphasisMark/></a:rPr>", True),
        ("a fill after the line", "<a:spPr><a:ln/><a:solidFill/></a:spPr>", True),
        ("a valid anchor", "<a:bodyPr anchor='ctr'/>", False),
        ("an invalid anchor", "<a:bodyPr anchor='middle'/>", True),
    ]
    failures: list[str] = []
    for label, body, should_flag in controls:
        try:
            root = ET.fromstring(f'<root xmlns:a="{drawing}">{body}</root>')
        except ET.ParseError as error:
            failures.append(f"{label}: the control itself does not parse ({error})")
            continue
        found = audit_child_order(root) + [
            problem for child in list(root) for problem in audit_enums(child)
        ] + audit_enums(root)
        if should_flag and not found:
            failures.append(f"{label}: the check did not fire")
        if not should_flag and found:
            failures.append(f"{label}: the check fired on a valid document ({found[0]})")
    if failures:
        print("Self-test failed:")
        for failure in failures:
            print("  " + failure)
        return 1
    print(f"Self-test passed: {len(controls)} controls")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx", type=Path, nargs="?")
    parser.add_argument("--require-gradient", action="store_true")
    parser.add_argument("--require-shadow", action="store_true")
    parser.add_argument("--require-alpha", action="store_true")
    parser.add_argument("--require-image-crop", action="store_true")
    parser.add_argument("--require-picture-effects", action="store_true")
    parser.add_argument("--require-table", action="store_true")
    parser.add_argument("--require-chart", action="store_true")
    parser.add_argument("--require-rotation", action="store_true")
    parser.add_argument("--require-merged-cells", action="store_true")
    parser.add_argument("--require-uneven-columns", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if args.pptx is None:
        parser.error("a .pptx is required unless --self-test is given")
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
        "chart": (args.require_chart, counts["charts"]),
        "rotation": (args.require_rotation, counts["rotated"]),
        "merged table cells": (args.require_merged_cells, counts["merged_cells"]),
        "uneven table columns": (args.require_uneven_columns, counts["uneven_tables"]),
    }
    missing = [name for name, (required, count) in requirements.items() if required and count < 1]
    if missing:
        raise SystemExit("Missing required editable OOXML features: " + ", ".join(missing))
    if counts["slides"] < 1:
        raise SystemExit("PPTX contains no slide XML parts")
    if counts.get("integrity_problems"):
        examples = counts.get("_integrity_examples") or []
        raise SystemExit("The package a reader would offer to repair ("
                         + str(counts["integrity_problems"]) + "): " + "; ".join(examples))
    if counts["invalid_enums"]:
        examples = counts.get("_problem_examples") or []
        raise SystemExit("Invalid enumerated values in the generated OOXML ("
                         + str(counts["invalid_enums"]) + "): " + "; ".join(examples))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
