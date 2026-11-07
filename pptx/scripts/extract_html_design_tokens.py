#!/usr/bin/env python3
"""Extract reusable design tokens from an HTML/CSS reference for Native PPT.

Usage:
  python extract_html_design_tokens.py reference.html output_dir
  python extract_html_design_tokens.py reference.css output_dir
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

STYLE_RE = re.compile(r"<style\b[^>]*>(.*?)</style>", re.I | re.S)
VAR_RE = re.compile(r"--([\w-]+)\s*:\s*([^;{}]+)")
RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}", re.S)
DECL_RE = re.compile(r"([\w-]+)\s*:\s*([^;]+)")
COLOR_RE = re.compile(r"^(?:#([0-9a-f]{3,8})|rgba?\([^)]*\)|hsla?\([^)]*\))$", re.I)


def read_css(path: Path) -> str:
    source = path.read_text(encoding="utf-8", errors="replace")
    blocks = STYLE_RE.findall(source)
    return "\n\n".join(blocks) if blocks else source


def normalize_color(value: str) -> str | None:
    value = value.strip()
    if value.startswith("#"):
        raw = value[1:]
        if len(raw) == 3:
            raw = "".join(ch * 2 for ch in raw)
        if len(raw) == 4:
            raw = "".join(ch * 2 for ch in raw[:3])
        if len(raw) == 8:
            raw = raw[:6]
        if len(raw) == 6 and re.fullmatch(r"[0-9a-fA-F]{6}", raw):
            return raw.upper()
        return None
    rgb = re.match(r"rgba?\(\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?(?:\s*,\s*[\d.]+)?\s*\)", value, re.I)
    if rgb:
        channels = [float(part) for part in rgb.groups()]
        if "%" in value:
            channels = [round(part * 2.55) for part in channels]
        channels = [max(0, min(255, round(part))) for part in channels]
        return "".join(f"{part:02X}" for part in channels)
    named = {"black": "000000", "white": "FFFFFF", "red": "FF0000",
             "green": "008000", "blue": "0000FF", "transparent": "FFFFFF"}
    return named.get(value.lower())


def length_to_inches(value: str) -> float | None:
    match = re.match(r"^(-?\d+(?:\.\d+)?)(px|pt|in|rem|em)?$", value.strip(), re.I)
    if not match:
        return None
    number = float(match.group(1))
    unit = (match.group(2) or "px").lower()
    factor = {"px": 1 / 96, "pt": 1 / 72, "in": 1, "rem": 16 / 96, "em": 16 / 96}[unit]
    return round(number * factor, 4)


def font_family(value: str) -> str:
    return value.strip().split(",")[0].strip().strip("\"'") or "Aptos"


def extract(css: str) -> dict:
    raw_vars: dict[str, str] = {}
    for name, value in VAR_RE.findall(css):
        raw_vars[name.lower()] = value.strip()

    colors: dict[str, str] = {}
    fonts: dict[str, str] = {}
    sizes: dict[str, float] = {}
    spacing: dict[str, float] = {}
    radii: dict[str, float] = {}
    typography: dict[str, object] = {}
    layouts: dict[str, float] = {}
    aliases = {
        "background": ("background", "bg", "canvas"),
        "foreground": ("foreground", "text", "ink", "body-text"),
        "primary": ("primary", "brand", "heading"),
        "secondary": ("secondary",),
        "accent": ("accent", "highlight", "brand-accent"),
        "muted": ("muted", "subtle", "secondary-text"),
        "surface": ("surface", "card", "panel"),
        "border": ("border", "line", "stroke")
    }
    for name, value in raw_vars.items():
        color = normalize_color(value)
        if color:
            for token, keys in aliases.items():
                if any(key in name for key in keys) and token not in colors:
                    colors[token] = color
            continue
        if "font" in name and "size" not in name and ("heading" in name or "title" in name or "display" in name):
            fonts.setdefault("heading", font_family(value))
        elif "font" in name and "size" not in name and ("cjk" in name or "east-asian" in name or "chinese" in name):
            fonts.setdefault("cjk", font_family(value))
        elif "font" in name and "size" not in name and ("body" in name or "text" in name or "family" in name):
            fonts.setdefault("body", font_family(value))
        length = length_to_inches(value)
        if length is not None:
            if "radius" in name or "round" in name:
                radii.setdefault("medium", max(0, length))
            elif "spacing" in name or "space" in name or "gap" in name:
                short = name.replace("spacing-", "").replace("space-", "").replace("gap-", "")
                spacing.setdefault(short if short in {"xs", "sm", "md", "lg", "xl"} else "md", max(0, length))
            elif "font-size" in name or "text-size" in name:
                key = "title" if ("title" in name or "h1" in name) else "heading" if ("heading" in name or "h2" in name) else "caption" if ("caption" in name or "small" in name) else "body"
                sizes.setdefault(key, round(length * 72, 2))
            elif "page-margin-x" in name or "page-gutter" in name:
                layouts.setdefault("pageMarginX", max(0, length))
            elif "page-margin-y" in name:
                layouts.setdefault("pageMarginY", max(0, length))
            elif "column-gap" in name:
                layouts.setdefault("columnGap", max(0, length))
            elif "section-gap" in name:
                layouts.setdefault("sectionGap", max(0, length))
        if "line-height" in name:
            try:
                typography.setdefault("lineSpacingMultiple", float(value))
            except ValueError:
                pass
        if "letter-spacing" in name:
            letter = length_to_inches(value)
            if letter is not None:
                typography.setdefault("bodyTracking", round(letter * 72, 2))
        if "font-weight" in name:
            if "heading" in name or "title" in name:
                typography.setdefault("titleWeight", value)
            else:
                typography.setdefault("bodyWeight", value)

    selectors: dict[str, dict[str, str]] = {}
    for selector_text, body in RULE_RE.findall(css):
        declarations = {k.lower(): v.strip() for k, v in DECL_RE.findall(body)}
        selector = selector_text.strip().lower()
        if selector in ("body", "html", ":root", "*", "h1", "h2", "h3", "p", ".card", ".slide-title"):
            selectors[selector] = declarations
    body = selectors.get("body", {})
    root = selectors.get(":root", {})
    for selector in (root, body):
        if "font-family" in selector:
            fonts.setdefault("body", font_family(selector["font-family"]))
        if "font-size" in selector:
            value = length_to_inches(selector["font-size"])
            if value:
                sizes.setdefault("body", round(value * 72, 2))
        if "background" in selector or "background-color" in selector:
            color = normalize_color(selector.get("background-color", selector.get("background", "")))
            if color:
                colors.setdefault("background", color)
        if "color" in selector:
            color = normalize_color(selector["color"])
            if color:
                colors.setdefault("foreground", color)

    for selector_name, token_name in (("h1", "title"), ("h2", "heading"), (".slide-title", "title"), ("p", "body")):
        rule = selectors.get(selector_name, {})
        if "font-family" in rule:
            fonts.setdefault("heading" if token_name != "body" else "body", font_family(rule["font-family"]))
        if "font-size" in rule:
            value = length_to_inches(rule["font-size"])
            if value:
                sizes.setdefault(token_name, round(value * 72, 2))
        if "color" in rule:
            color = normalize_color(rule["color"])
            if color:
                colors.setdefault("primary" if token_name in ("title", "heading") else "foreground", color)
    card = selectors.get(".card", {})
    if "background" in card or "background-color" in card:
        color = normalize_color(card.get("background-color", card.get("background", "")))
        if color:
            colors.setdefault("surface", color)
    if "border-color" in card:
        color = normalize_color(card["border-color"])
        if color:
            colors.setdefault("border", color)
    if "border-radius" in card:
        value = length_to_inches(card["border-radius"])
        if value is not None:
            radii.setdefault("medium", value)

    return {
        "source": "html-css",
        "rawCssVariables": raw_vars,
        "theme": {
            "colors": colors, "fonts": fonts, "sizes": sizes,
            "spacing": spacing, "radii": radii,
            "typography": typography, "layouts": layouts
        },
        "cssSelectors": selectors,
        "notes": [
            "CSS tokens are best-effort mappings; review before production use.",
            "Complex selectors, gradients, filters, pseudo-elements and browser-only effects are preserved only in rawCssVariables/source CSS, not recreated automatically as PowerPoint effects."
        ]
    }


def self_test() -> None:
    css = """
    :root { --color-primary: #123456; --color-accent: #e56a42;
            --font-heading: 'Aptos Display', sans-serif; --space-lg: 32px;
            --radius-card: 12px; --font-size-title: 36px; }
    body { color: #222222; background: #f7f7f4; font-family: Arial, sans-serif; }
    """
    result = extract(css)
    theme = result["theme"]
    assert theme["colors"]["primary"] == "123456", theme
    assert theme["colors"]["accent"] == "E56A42", theme
    assert theme["fonts"]["heading"] == "Aptos Display", theme
    assert theme["sizes"]["title"] == 27.0, theme
    assert theme["spacing"]["lg"] == round(32 / 96, 4), theme
    assert theme["radii"]["medium"] == round(12 / 96, 4), theme
    assert normalize_color("rgb(18, 52, 86)") == "123456"
    assert theme["typography"] == {}, theme
    print("HTML/CSS design token extraction self-test passed.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?")
    parser.add_argument("output_dir", nargs="?")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not args.source or not args.output_dir:
        parser.error("source and output_dir are required")
    source = Path(args.source)
    if not source.is_file():
        print(f"error: {source} is not a file", file=sys.stderr)
        return 2
    css = read_css(source)
    result = extract(css)
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "design-tokens.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "theme.json").write_text(json.dumps(result["theme"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "source.css").write_text(css, encoding="utf-8")
    print(f"wrote {out / 'design-tokens.json'}, theme.json, and source.css")
    return 0


if __name__ == "__main__":
    sys.exit(main())
