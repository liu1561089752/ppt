#!/usr/bin/env python3
"""Render a generated PPTX to PNG with Pillow for offline layout review.

This is a *layout preview*, not a faithful Office renderer. It exists so that
geometry, z-order, colour and text fitting can be inspected without
LibreOffice or PowerPoint installed. It reads the real PPTX geometry and text
through python-pptx, so a wrong box position or an overflowing text box is
visible here; glyph shaping, kerning, gradients, shadows and effects are only
approximated.

Usage:
    python scripts/preview_deck.py deck.pptx
    python scripts/preview_deck.py deck.pptx --output-dir preview --scale 1.0
    python scripts/preview_deck.py deck.pptx --sheet preview/sheet.png
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN

EMU_PER_INCH = 914400
PX_PER_INCH = 96

# Family name -> (regular, bold) font files, tried in order.
FONT_CANDIDATES = [
    ("", ["C:/Windows/Fonts/msyh.ttc", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
          "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
          "/System/Library/Fonts/PingFang.ttc"]),
    ("yahei", ["C:/Windows/Fonts/msyh.ttc", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"]),
    ("segoe", ["C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]),
    ("aptos", ["C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]),
    ("calibri", ["C:/Windows/Fonts/calibri.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]),
    ("arial", ["C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]),
    ("georgia", ["C:/Windows/Fonts/georgia.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"]),
    ("consolas", ["C:/Windows/Fonts/consola.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]),
]
BOLD_SUFFIX = {
    "C:/Windows/Fonts/msyh.ttc": "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/segoeui.ttf": "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/calibri.ttf": "C:/Windows/Fonts/calibrib.ttf",
    "C:/Windows/Fonts/arial.ttf": "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/consola.ttf": "C:/Windows/Fonts/consolab.ttf",
}

# A CJK-capable face is required for any run that contains CJK text: a Latin
# face would silently render tofu boxes and hide real layout problems.
CJK_FONT_FILES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]
CJK_BOLD_FILES = {
    "C:/Windows/Fonts/msyh.ttc": "C:/Windows/Fonts/msyhbd.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc":
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
}

_font_cache: dict[tuple[str, int, bool, bool], ImageFont.FreeTypeFont] = {}


def has_cjk(text: str) -> bool:
    for char in text or "":
        code = ord(char)
        if 0x2E80 <= code <= 0x9FFF or 0xF900 <= code <= 0xFAFF or 0xFF00 <= code <= 0xFFEF:
            return True
    return False


def resolve_cjk_font_file(bold: bool) -> str | None:
    for candidate in CJK_FONT_FILES:
        if Path(candidate).is_file():
            if bold:
                bold_file = CJK_BOLD_FILES.get(candidate)
                if bold_file and Path(bold_file).is_file():
                    return bold_file
            return candidate
    return None


def resolve_font_file(name: str, bold: bool) -> str:
    lowered = (name or "").lower()
    chosen = None
    for key, files in FONT_CANDIDATES:
        if key and key in lowered:
            for candidate in files:
                if Path(candidate).is_file():
                    chosen = candidate
                    break
        if chosen:
            break
    if chosen is None:
        for _key, files in FONT_CANDIDATES:
            for candidate in files:
                if Path(candidate).is_file():
                    chosen = candidate
                    break
            if chosen:
                break
    if chosen and bold:
        replacement = BOLD_SUFFIX.get(chosen)
        if replacement and Path(replacement).is_file():
            return replacement
    return chosen or ""


def load_font(name: str, size_px: int, bold: bool, cjk: bool = False) -> ImageFont.FreeTypeFont:
    key = (name or "", size_px, bold, cjk)
    if key in _font_cache:
        return _font_cache[key]
    path = (resolve_cjk_font_file(bold) if cjk else None) or resolve_font_file(name, bold)
    try:
        font = ImageFont.truetype(path, size_px) if path else ImageFont.load_default()
    except OSError:
        font = ImageFont.load_default()
    _font_cache[key] = font
    return font


def emu_to_px(value) -> int:
    return int(round((value or 0) / EMU_PER_INCH * PX_PER_INCH))


def rgb_of(color_format):
    try:
        rgb = color_format.rgb
    except (AttributeError, TypeError):
        return None
    if rgb is None:
        return None
    return (rgb[0], rgb[1], rgb[2])


def fill_color_of(shape):
    try:
        fill = shape.fill
        if fill.type is None:
            return None
        colour = rgb_of(fill.fore_color)
        if colour:
            return colour
        try:
            stops = fill.gradient_stops
        except (AttributeError, TypeError, ValueError):
            return None
        if stops:
            return rgb_of(stops[0].color)
    except (AttributeError, TypeError, ValueError, NotImplementedError):
        return None
    return None


_ALPHA_TAG = "{http://schemas.openxmlformats.org/drawingml/2006/main}alpha"


def line_alpha(line) -> float:
    """Read <a:alpha> from a line, so 'no outline' (100% transparent) stays invisible."""
    try:
        element = line._ln
    except (AttributeError, ValueError):
        return 1.0
    if element is None:
        return 1.0
    alpha = element.find(".//" + _ALPHA_TAG)
    if alpha is None:
        return 1.0
    try:
        return max(0.0, min(1.0, int(alpha.get("val", "100000")) / 100000))
    except (TypeError, ValueError):
        return 1.0


def line_of(shape):
    try:
        line = shape.line
        colour = rgb_of(line.color)
        width = line.width
    except (AttributeError, TypeError, ValueError, NotImplementedError):
        return None, 0
    if colour is None:
        return None, 0
    if line_alpha(line) < 0.06:
        return None, 0
    points = (width / 12700) if width else 0.75
    return colour, max(1, int(round(points / 72 * PX_PER_INCH)))


A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def radius_px_from_geometry(shape, width: int, height: int) -> int:
    """Read <a:prstGeom prst="roundRect"> and its adj value straight from XML."""
    try:
        element = shape._element
    except AttributeError:
        return 0
    geometry = element.find(".//" + A_NS + "prstGeom")
    if geometry is None or geometry.get("prst") != "roundRect":
        return 0
    adjustment = 0.16667
    guide = geometry.find(".//" + A_NS + "gd")
    if guide is not None:
        formula = str(guide.get("fmla", "")).split()
        if formula:
            try:
                adjustment = int(formula[-1]) / 100000.0
            except (TypeError, ValueError):
                adjustment = 0.16667
    return int(round(min(width, height) * max(0.0, min(0.5, adjustment))))


def corner_radius(shape, width: int, height: int) -> int:
    try:
        if shape.auto_shape_type is None:
            return 0
    except (AttributeError, ValueError):
        return 0
    name = str(shape.auto_shape_type)
    if "ROUNDED_RECTANGLE" not in name and "ROUND_2" not in name:
        return 0
    try:
        adjustment = float(shape.adjustments[0])
    except (IndexError, TypeError, ValueError):
        adjustment = 0.16667
    return int(round(min(width, height) * max(0.0, min(0.5, adjustment))))


def draw_picture(canvas: Image.Image, shape, box, radius: int = 0, outline=None, outline_width: int = 0):
    try:
        blob = shape.image.blob
    except (AttributeError, ValueError, KeyError):
        return False
    import io

    try:
        source = Image.open(io.BytesIO(blob)).convert("RGBA")
    except (OSError, ValueError):
        return False
    width = source.width
    height = source.height
    left = int(round((shape.crop_left or 0) * width))
    right = int(round((shape.crop_right or 0) * width))
    top = int(round((shape.crop_top or 0) * height))
    bottom = int(round((shape.crop_bottom or 0) * height))
    if left or right or top or bottom:
        box_crop = (left, top, max(left + 1, width - right), max(top + 1, height - bottom))
        source = source.crop(box_crop)
    target_w = max(1, box[2] - box[0])
    target_h = max(1, box[3] - box[1])
    scaled = source.resize((target_w, target_h), Image.LANCZOS)
    if radius:
        mask = Image.new("L", (target_w, target_h), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, target_w - 1, target_h - 1), radius=radius, fill=255)
        scaled.putalpha(mask)
        canvas.alpha_composite(scaled, (box[0], box[1]))
    elif canvas.mode == "RGBA":
        canvas.alpha_composite(scaled, (box[0], box[1]))
    else:
        canvas.paste(scaled, (box[0], box[1]), scaled)
    if outline and outline_width:
        ImageDraw.Draw(canvas).rounded_rectangle(box, radius=radius, outline=outline,
                                                 width=outline_width)
    return True


def wrap_line(text: str, font: ImageFont.FreeTypeFont, available: float) -> list[str]:
    if not text:
        return [""]
    lines: list[str] = []
    current = ""
    for char in text:
        candidate = current + char
        if current and font.getlength(candidate) > available:
            lines.append(current)
            current = char
        else:
            current = candidate
    lines.append(current)
    return lines


def draw_text(draw: ImageDraw.ImageDraw, frame, box, warnings):
    if frame is None:
        return
    left, top, right, bottom = box
    padding = emu_to_px(91440)  # ~0.1in default inset
    inset_left = emu_to_px(frame.margin_left) if frame.margin_left is not None else padding
    inset_right = emu_to_px(frame.margin_right) if frame.margin_right is not None else padding
    inset_top = emu_to_px(frame.margin_top) if frame.margin_top is not None else padding // 2
    inset_bottom = emu_to_px(frame.margin_bottom) if frame.margin_bottom is not None else padding // 2
    available = max(1, (right - left) - inset_left - inset_right)

    blocks = []
    total_height = 0.0
    for paragraph in frame.paragraphs:
        runs = [run for run in paragraph.runs if run.text]
        size_pt = 0.0
        for run in runs:
            try:
                if run.font.size is not None:
                    size_pt = max(size_pt, run.font.size.pt)
            except (AttributeError, ValueError):
                continue
        line_px = max(1, int(round((size_pt or 16) / 72 * PX_PER_INCH)))
        if not runs:
            blocks.append({"lines": [], "line_px": line_px, "alignment": None,
                           "colour": (0, 0, 0), "font": None, "height": line_px * 1.22})
            total_height += line_px * 1.22
            continue
        first = runs[0]
        text = "".join(run.text for run in runs)
        font = load_font(first.font.name or "", line_px, bool(first.font.bold), has_cjk(text))
        lines: list[str] = []
        for segment in text.split("\n"):
            lines.extend(wrap_line(segment, font, available))
        colour = rgb_of(first.font.color) or (32, 35, 33)
        height = len(lines) * line_px * 1.22
        blocks.append({"lines": lines, "line_px": line_px, "alignment": paragraph.alignment,
                       "colour": colour, "font": font, "height": height})
        total_height += height

    usable = (bottom - top) - inset_top - inset_bottom
    if total_height > usable + 1:
        warnings.append(
            f"text overflow: {total_height:.0f}px of text in {usable:.0f}px box -> {frame.text[:18]!r}")

    anchor = frame.vertical_anchor
    if anchor == MSO_ANCHOR.MIDDLE:
        cursor = top + inset_top + max(0.0, (usable - total_height) / 2)
    elif anchor == MSO_ANCHOR.BOTTOM:
        cursor = bottom - inset_bottom - total_height
    else:
        cursor = top + inset_top

    for block in blocks:
        if not block["lines"]:
            cursor += block["height"]
            continue
        font = block["font"]
        for line in block["lines"]:
            line_width = font.getlength(line)
            if block["alignment"] == PP_ALIGN.CENTER:
                x = left + inset_left + max(0.0, (available - line_width) / 2)
            elif block["alignment"] == PP_ALIGN.RIGHT:
                x = left + inset_left + max(0.0, available - line_width)
            else:
                x = left + inset_left
            draw.text((x, cursor), line, font=font, fill=block["colour"])
            cursor += block["line_px"] * 1.22


def interpolate_stops(stops, t):
    if not stops:
        return (255, 255, 255)
    if t <= stops[0][0]:
        return stops[0][1]
    if t >= stops[-1][0]:
        return stops[-1][1]
    for index in range(1, len(stops)):
        prev_pos, prev_colour = stops[index - 1]
        next_pos, next_colour = stops[index]
        if t <= next_pos:
            span = next_pos - prev_pos
            ratio = 0.0 if span <= 0 else (t - prev_pos) / span
            return tuple(int(round(prev_colour[channel] +
                                   (next_colour[channel] - prev_colour[channel]) * ratio))
                         for channel in range(3))
    return stops[-1][1]


def linear_gradient(size, stops, angle_degrees):
    """Draw a real linear gradient so a wrong gradient direction is visible."""
    import math

    width, height = size
    diagonal = int(math.hypot(width, height)) + 4
    ramp = Image.new("RGB", (diagonal, 1))
    for x in range(diagonal):
        ramp.putpixel((x, 0), interpolate_stops(stops, x / max(1, diagonal - 1)))
    square = ramp.resize((diagonal, diagonal), Image.NEAREST)
    rotated = square.rotate(-angle_degrees, resample=Image.BILINEAR, expand=False)
    left = (diagonal - width) // 2
    top = (diagonal - height) // 2
    return rotated.crop((left, top, left + width, top + height))


def gradient_of(shape):
    """Return (stops, angle) for a linear gradient fill, or None."""
    try:
        fill = shape.fill
        if "GRADIENT" not in str(fill.type):
            return None
        stops = []
        for stop in fill.gradient_stops:
            colour = rgb_of(stop.color)
            if colour is None:
                continue
            stops.append((float(stop.position), colour))
        if not stops:
            return None
        stops.sort(key=lambda item: item[0])
        try:
            # python-pptx reports the angle counter-clockwise from horizontal,
            # while DrawingML (and linear_gradient) measure clockwise.
            angle = (360.0 - float(fill.gradient_angle)) % 360.0
        except (AttributeError, TypeError, ValueError):
            angle = 0.0
        return stops, angle
    except (AttributeError, TypeError, ValueError, NotImplementedError):
        return None


def draw_table(draw: ImageDraw.ImageDraw, shape, box, warnings):
    table = shape.table
    column_edges = [box[0]]
    for column in table.columns:
        column_edges.append(column_edges[-1] + emu_to_px(column.width))
    row_edges = [box[1]]
    for row in table.rows:
        row_edges.append(row_edges[-1] + emu_to_px(row.height))
    for row_index, row in enumerate(table.rows):
        for column_index, cell in enumerate(row.cells):
            cell_box = (column_edges[column_index], row_edges[row_index],
                        column_edges[column_index + 1], row_edges[row_index + 1])
            cell_fill = fill_color_of(cell)
            if cell_fill:
                draw.rectangle(cell_box, fill=cell_fill)
            draw.rectangle(cell_box, outline=(214, 219, 214), width=1)
            if cell.text_frame.text.strip():
                draw_text(draw, cell.text_frame, cell_box, warnings)
    if row_edges[-1] > box[3] + 2:
        warnings.append(
            f"table taller than its frame: {row_edges[-1] - box[1]}px inside {box[3] - box[1]}px")


def draw_chart_placeholder(draw: ImageDraw.ImageDraw, shape, box):
    """Charts are live DrawingML parts; draw an honest labelled placeholder."""
    label = "chart (live object, not previewed)"
    try:
        if shape.has_chart:
            label = f"chart: {shape.chart.chart_type} (live object)"
    except (AttributeError, ValueError):
        pass
    draw.rectangle(box, fill=(246, 247, 244), outline=(190, 198, 194), width=1)
    font = load_font("", 13, False)
    label_width = font.getlength(label)
    draw.text((box[0] + max(6, ((box[2] - box[0]) - label_width) / 2),
               box[1] + ((box[3] - box[1]) / 2) - 7), label, font=font, fill=(142, 150, 146))


def render_slide(slide, width: int, height: int, warnings: list[str]) -> Image.Image:
    canvas = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    background_gradient = gradient_of(slide.background)
    if background_gradient:
        canvas.paste(linear_gradient((width, height), *background_gradient), (0, 0))
        draw = ImageDraw.Draw(canvas)
    else:
        try:
            background = fill_color_of(slide.background)
        except (AttributeError, TypeError, ValueError):
            background = None
        if background:
            draw.rectangle([0, 0, width, height], fill=background)

    for shape in slide.shapes:
        box = (emu_to_px(shape.left), emu_to_px(shape.top),
               emu_to_px(shape.left) + emu_to_px(shape.width),
               emu_to_px(shape.top) + emu_to_px(shape.height))
        try:
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                picture_radius = radius_px_from_geometry(shape, box[2] - box[0], box[3] - box[1])
                picture_outline, picture_outline_width = line_of(shape)
                if not draw_picture(canvas, shape, box, picture_radius,
                                    picture_outline, picture_outline_width):
                    draw.rectangle(box, outline=(200, 120, 120), width=1)
                continue
            if getattr(shape, "has_table", False) and shape.has_table:
                draw_table(draw, shape, box, warnings)
                continue
            if getattr(shape, "has_chart", False) and shape.has_chart:
                draw_chart_placeholder(draw, shape, box)
                continue
            shape_box = (box[2] - box[0], box[3] - box[1])
            gradient = gradient_of(shape)
            fill = None if gradient else fill_color_of(shape)
            outline, outline_width = line_of(shape)
            radius = corner_radius(shape, shape_box[0], shape_box[1])
            if gradient and shape_box[0] > 0 and shape_box[1] > 0:
                layer = linear_gradient(shape_box, *gradient).convert("RGBA")
                if radius:
                    mask = Image.new("L", shape_box, 0)
                    ImageDraw.Draw(mask).rounded_rectangle(
                        (0, 0, shape_box[0] - 1, shape_box[1] - 1), radius=radius, fill=255)
                    canvas.paste(layer, (box[0], box[1]), mask)
                else:
                    canvas.paste(layer, (box[0], box[1]))
                draw = ImageDraw.Draw(canvas)
                if outline:
                    draw.rectangle(box, outline=outline, width=outline_width or 1)
            elif fill or outline:
                if radius:
                    draw.rounded_rectangle(box, radius=radius, fill=fill,
                                           outline=outline, width=outline_width or 1)
                else:
                    draw.rectangle(box, fill=fill, outline=outline, width=outline_width or 1)
            if shape.has_text_frame and shape.text_frame.text.strip():
                draw_text(draw, shape.text_frame, box, warnings)
        except Exception as error:  # noqa: BLE001 - a preview must never abort
            warnings.append(f"{shape.shape_id}: {type(error).__name__}: {error}")
    return canvas


def contact_sheet(images: list[Image.Image], columns: int = 3, gap: int = 12) -> Image.Image:
    if not images:
        return Image.new("RGBA", (10, 10), (255, 255, 255, 255))
    tile_w, tile_h = images[0].size
    scale = 0.42
    thumb_w, thumb_h = int(tile_w * scale), int(tile_h * scale)
    rows = (len(images) + columns - 1) // columns
    sheet = Image.new("RGBA", (columns * thumb_w + gap * (columns + 1),
                              rows * thumb_h + gap * (rows + 1)), (235, 236, 238, 255))
    for index, image in enumerate(images):
        row, column = divmod(index, columns)
        x = gap + column * (thumb_w + gap)
        y = gap + row * (thumb_h + gap)
        sheet.paste(image.resize((thumb_w, thumb_h), Image.LANCZOS), (x, y))
    return sheet


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--sheet", type=Path, default=None,
                        help="Write a contact sheet of every slide to this path.")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    if not args.pptx.is_file():
        parser.error(f"PPTX not found: {args.pptx}")

    output_dir = args.output_dir or args.pptx.parent / "preview"
    output_dir.mkdir(parents=True, exist_ok=True)

    presentation = Presentation(str(args.pptx))
    width = int(round(presentation.slide_width / EMU_PER_INCH * PX_PER_INCH * args.scale))
    height = int(round(presentation.slide_height / EMU_PER_INCH * PX_PER_INCH * args.scale))

    images = []
    problems = 0
    for index, slide in enumerate(presentation.slides, start=1):
        warnings: list[str] = []
        image = render_slide(slide, width, height, warnings)
        images.append(image)
        target = output_dir / f"slide-{index:02d}.png"
        image.convert("RGB").save(target)
        problems += len(warnings)
        if warnings and not args.quiet:
            for warning in warnings[:6]:
                print(f"  slide {index}: {warning}", file=sys.stderr)

    if args.sheet:
        args.sheet.parent.mkdir(parents=True, exist_ok=True)
        contact_sheet(images).convert("RGB").save(args.sheet)
        print(f"contact sheet: {args.sheet}")

    print(f"rendered {len(images)} slide(s) at {width}x{height} into {output_dir}")
    if problems:
        print(f"{problems} preview warning(s); see above", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
