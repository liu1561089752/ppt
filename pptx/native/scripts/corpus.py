"""The native deck corpus: the decks the visual gates photograph.

Every entry names a **spec**, not a stylesheet. A spec is either a JSON document or a JS module
built from `templates.*` / `components.*`, and it is turned into a `.pptx` by the tool itself:

    node native/cli.js <spec> <out.pptx>

or, for the demo scripts that predate the CLI, by running the script with the output path as its
first argument. A script that draws pictures may write its own PNGs; `{assets}` in an entry's `args`
is replaced by a temporary directory, so a corpus deck needs no committed binary and stays
reproducible on a clean clone.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
EXAMPLES = NATIVE.parent / "examples"
MANIFEST = NATIVE / "golden" / "specs.json"


def entries():
    """The corpus as listed in golden/specs.json, in a stable order."""
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return data["decks"]


def layout_path(entry, workdir):
    return Path(workdir) / (entry["name"] + "-layout.json")


def build(entry, workdir, need_layout=False):
    """Build one deck. Returns (deck, layout) - layout is None unless it was asked for."""
    workdir = Path(workdir)
    name = entry["name"]
    deck = workdir / (name + ".pptx")
    layout = None
    if entry.get("spec"):
        command = ["node", str(NATIVE / "cli.js"), str(EXAMPLES / entry["spec"]), str(deck)]
    elif entry.get("run"):
        assets = workdir / ("assets-" + name)
        assets.mkdir(parents=True, exist_ok=True)
        command = ["node", str(EXAMPLES / entry["run"]), str(deck)]
        command += [str(assets) if arg == "{assets}" else arg for arg in entry.get("args", [])]
    else:
        raise SystemExit("corpus entry " + name + " has neither `spec` nor `run`")
    environment = dict(os.environ)
    if need_layout:
        layout = layout_path(entry, workdir)
        if entry.get("spec"):
            command += ["--layout-out", str(layout)]
        else:
            # A demo script takes no flags: it builds its own deck, so the layout is requested
            # through the environment the writer already understands.
            environment["NATIVE_LAYOUT_OUT"] = str(layout)
    # A deck's title is UTF-8 and this machine's console is not: decode explicitly.
    result = subprocess.run(command, cwd=str(NATIVE), stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, encoding="utf-8", errors="replace",
                            env=environment)
    if not deck.exists():
        print("  build failed for " + name + ":\n" + result.stdout[-2000:])
        return None, None
    if need_layout and not layout.exists():
        print("  no layout for " + name + " (the writer did not report its boxes)")
        return deck, None
    return deck, layout
