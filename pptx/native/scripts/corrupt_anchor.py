"""Write a copy of a deck with one enumerated attribute made invalid.

Used to prove that the compatibility check notices what a renderer silently tolerates.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: corrupt_anchor.py <source.pptx> <target.pptx> <value>")
        return 2
    source, target, value = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    with zipfile.ZipFile(source) as archive:
        items = [(info, archive.read(info.filename)) for info in archive.infolist()]
    touched = 0
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as out:
        for info, data in items:
            if info.filename.startswith("ppt/slides/slide") and info.filename.endswith(".xml"):
                text = data.decode("utf-8")
                if 'anchor="ctr"' in text:
                    text = text.replace('anchor="ctr"', f'anchor="{value}"')
                    touched += text.count(f'anchor="{value}"')
                data = text.encode("utf-8")
            out.writestr(info, data)
    print(f"rewrote {touched} anchor value(s) into {target}")
    return 0 if touched else 1


if __name__ == "__main__":
    raise SystemExit(main())
