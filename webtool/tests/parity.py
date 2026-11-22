#!/usr/bin/env python3
"""Parity test: the main project's board, imported and exported without edits, must come out the same.

    ../.venv/bin/python tests/parity.py           uses ../out (makes a board first when there is none)
    ../.venv/bin/python tests/parity.py --fresh   runs make_tiles.py first (takes minutes)

Run it after every change in ../src. It works in a temporary folder and leaves designs, settings and ../out alone.
It checks the export. The editor draws the board itself (static/js/render.js): when this test fails because
compose_board.py draws something differently, change the editor too.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import numpy as np  # noqa: E402
import server  # noqa: E402
from PIL import Image  # noqa: E402

FAILED = []


def check(what, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + what + (f": {detail}" if detail and not ok else ""))
    if not ok:
        FAILED.append(what)


def finish(job):
    while job.status == "running":
        time.sleep(0.3)
    if job.status != "done":
        sys.exit("\n".join(job.log[-20:]))


def pipeline(script, *args):
    subprocess.run([server.PY, str(server.SRC / script), *map(str, args)], cwd=server.SRC, env=server.ENV,
                   check=True, stdout=subprocess.DEVNULL)


def first_difference(a, b):
    if len(a) != len(b):
        return f"{len(a)} in the pipeline, {len(b)} in the web tool"
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return f"#{i}: pipeline {str(x)[:170]} | web tool {str(y)[:170]}"
    return ""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fresh", action="store_true", help="make a new board with the current pipeline first")
    args = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="seaboard-parity-"))
    try:
        ref = tmp / "pipeline"
        data = server.data_path(server.main_config())
        common = ["--set", f"output_dir={ref}", "--set", f"data_dir={data}"]
        if args.fresh or not (server.MAIN_OUT / "tiles/tiles.json").exists():
            print("running make_tiles.py (minutes)")
            pipeline("make_tiles.py", *common)
            pipeline("make_art.py", "guide", *common)
        else:
            for sub in ("tiles", "art"):
                shutil.copytree(server.MAIN_OUT / sub, ref / sub, ignore=shutil.ignore_patterns("samples"))
        pipeline("compose_board.py", "--no-png", *common)

        server.MAIN_OUT = ref
        server.STATE, server.DESIGNS, server.RUNS = tmp / "state", tmp / "designs", tmp / "runs"
        server.MY_CONFIG = server.STATE / "config.yaml"     # none: pure main config
        finish(server.job_import_main("parity"))
        finish(server.job_export("parity", False))
        exp = server.DESIGNS / "parity/export"
        theirs = json.loads((ref / "tiles/tiles.json").read_text())
        ours = json.loads((exp / "tiles/tiles.json").read_text())

        check("no section is missing from tiles.json", set(theirs) <= set(ours), set(theirs) - set(ours))
        for key, value in theirs["board"].items():
            check(f"board.{key}", ours["board"].get(key) == value, f"{value} | {ours['board'].get(key)}")
        # these two only describe how the pipeline searched for a label position
        ignore = {"label_clear_mm", "label_inside"}
        for part in ("tiles", "seas", "edges", "wraps", "passages"):
            a = [{k: v for k, v in x.items() if k not in ignore} for x in theirs[part]]
            # only the pipeline's keys count: the tool may add its own
            b = [{k: y.get(k) for k in x} for x, y in zip(a, ours[part])] + ours[part][len(a):]
            check(part, a == b, first_difference(a, b))
        a = json.loads((ref / "tiles/borders.json").read_text())
        b = json.loads((exp / "tiles/borders.json").read_text())
        check("borders", a == b, first_difference(a, b))

        # every map layer, element by element; day track and legend are fields here, so those are compared as pixels
        mine = (exp / "board.svg").read_text().split("\n")[3:]
        mine = mine[:mine.index("</svg>")]
        full = (ref / "board/board.svg").read_text().split("\n")[1:]
        panel = f'<line x1="0" y1="{theirs["board"]["map_height_mm"]:.2f}"'
        end = next((i for i, el in enumerate(full) if el.startswith(panel)), full.index("</svg>"))
        check("map layers", mine == full[:end], first_difference(full[:end], mine))
        # the tool draws the arrows itself when their size or colour is changed: same drawing at the standard style
        c = server.main_config()["compose"]
        drawn = "\n".join(server.arrows_svg(theirs["wraps"], theirs["board"]["width_mm"], c["font"], c["border_color"]))
        check("the tool's own arrow drawing", drawn in "\n".join(full),
              "compose_board.py draws arrows differently: change arrows_svg (server.py) and the arrows in render.js")
        a = np.asarray(Image.open(ref / "board/board_preview.jpg").convert("RGB")).astype(int)
        b = np.asarray(Image.open(exp / "board_preview.jpg").convert("RGB")).astype(int)
        if a.shape != b.shape:
            check("board image size", False, f"{a.shape} | {b.shape}")
        else:
            off = float((np.abs(a - b).max(2) > 60).mean())
            check("board image", off < 2e-5, f"{off:.4%} of the pixels differ")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if FAILED:
        sys.exit(f"\n{len(FAILED)} difference(s): {', '.join(FAILED)}")
    print("\nsame board")


if __name__ == "__main__":
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    main()
