#!/usr/bin/env python3
"""Reference test: the board must come out exactly as it did when the references were saved.

    ../.venv/bin/python tests/reference.py            check (about 3 minutes)
    ../.venv/bin/python tests/reference.py --full     also the real board settings (5 more minutes, longer before PR 2)
    ../.venv/bin/python tests/reference.py --update   save new references (only after a change that SHOULD change the board)

It runs the pipeline and the web tool on fixed settings (tests/reference_config.yaml, not ../src/config.yaml,
so your own settings never break it) and compares fingerprints (SHA-256) of every output with
tests/reference.json. It works in a temporary folder and leaves designs, settings and ../out alone.

Cases:
  quick        5 tiles steps, 1 refine round: tiles, atlas map, pipeline board, web tool import + export
  no-wiggle    as quick without border noise: many exact ties in the tile search
  board        the reference settings unchanged (only with --full)

The fingerprints depend on the library versions in requirements.txt. When a check fails, the versions used
for the references are printed next to yours.
"""
import argparse
import hashlib
import importlib.metadata
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.dont_write_bytecode = True
TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent))
import server  # noqa: E402

CONFIG = TESTS / "reference_config.yaml"
REFERENCE = TESTS / "reference.json"
QUICK = ["tiles.lloyd_iterations=4", "tiles.refine_rounds=1"]
CASES = {"quick": QUICK, "no-wiggle": QUICK + ["tiles.border_noise=0"], "board": []}
TILE_FILES = ["tiles/labels.npy", "tiles/tiles.json", "tiles/borders.json", "tiles/report.txt"]
PACKAGES = ["numpy", "scipy", "numba", "pillow", "cairosvg", "pyshp", "PyYAML"]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:20]


def sha_json(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]


def pipeline(script, out, data, sets=(), extra=()):
    """Run a pipeline script on the reference settings; `extra` are its own arguments (e.g. guide, --no-png)."""
    args = [server.PY, str(server.SRC / script), *extra, "--config", str(CONFIG),
            "--set", f"output_dir={out}", "--set", f"data_dir={data}"]
    for s in sets:
        args += ["--set", s]
    subprocess.run(args, cwd=server.SRC, env=server.ENV, check=True, stdout=subprocess.DEVNULL)


def finish(job):
    while job.status == "running":
        time.sleep(0.3)
    if job.status != "done":
        sys.exit("\n".join(job.log[-20:]))


def web_tool(out, data, tmp):
    """Import a pipeline output into the web tool and export it, in a temporary state."""
    server.MAIN_OUT = out
    server.MAIN_CONFIG = CONFIG
    server.STATE, server.DESIGNS, server.RUNS = tmp / "state", tmp / "designs", tmp / "runs"
    server.MY_CONFIG = server.STATE / "config.yaml"      # none: only the reference settings
    server.data_path = lambda cfg: Path(data)
    finish(server.job_import_main("ref"))
    d = server.DESIGNS / "ref"
    design = json.loads((d / "design.json").read_text())
    for key in ("created", "modified", "source"):       # time and temporary paths
        design.pop(key, None)
    finish(server.job_export("ref", False))
    exp = d / "export"
    return {"design.json": sha_json(design), "labels.bin": sha(d / "labels.bin"), "water.bin": sha(d / "water.bin"),
            "export tiles.json": sha(exp / "tiles/tiles.json"), "export borders.json": sha(exp / "tiles/borders.json"),
            "export board.svg": sha(exp / "board.svg")}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--full", action="store_true", help="also the real board settings")
    ap.add_argument("--update", action="store_true", help="save the outputs as the new references")
    ap.add_argument("--data", help="Natural Earth folder (default: the one the web tool uses)")
    args = ap.parse_args()
    data = Path(args.data or server.data_path(server.load_yaml(CONFIG))).resolve()
    if not (data / "ne_50m_land").is_dir():
        sys.exit(f"no Natural Earth data in {data}: start the web tool once, or pass --data")
    saved = json.loads(REFERENCE.read_text()) if REFERENCE.exists() else {"cases": {}}
    names = ["quick", "no-wiggle"] + (["board"] if args.full else [])
    versions = {p: importlib.metadata.version(p) for p in PACKAGES}
    tmp = Path(tempfile.mkdtemp(prefix="seaboard-reference-"))
    results = {}
    try:
        for name in names:
            print(f"{name} ({' '.join(CASES[name]) or 'reference settings'})", flush=True)
            out = tmp / name
            t = time.time()
            pipeline("make_tiles.py", out, data, CASES[name])
            got = {f: sha(out / f) for f in TILE_FILES}
            print(f"  tiles: {time.time() - t:.0f} s", flush=True)
            if name == "quick":
                pipeline("make_art.py", out, data, extra=["guide"])
                got["art/guide.png"] = sha(out / "art/guide.png")
                pipeline("compose_board.py", out, data, extra=["--no-png"])
                got["board/board.svg"] = sha(out / "board/board.svg")
                got.update(web_tool(out, data, tmp / "web"))
            results[name] = got
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if args.update:
        saved["cases"].update(results)
        saved["versions"] = versions
        saved["note"] = "made by tests/reference.py --update; fingerprints are the first 20 hex digits of SHA-256"
        REFERENCE.write_text(json.dumps(saved, indent=1) + "\n")
        print(f"\nreferences saved for: {', '.join(results)}")
        return
    failed = []
    for name, got in results.items():
        want = saved["cases"].get(name)
        if want is None:
            print(f"{name}: no reference yet (run with --update)")
            failed.append(name)
            continue
        for f in sorted(set(want) | set(got)):
            ok = want.get(f) == got.get(f)
            print(("ok    " if ok else "FAIL  ") + f"{name}: {f}")
            if not ok:
                failed.append(f"{name}: {f}")
    if failed:
        old = saved.get("versions", {})
        diff = [f"{p} {old.get(p)} -> {v}" for p, v in versions.items() if old.get(p) != v]
        sys.exit(f"\n{len(failed)} difference(s)." + (" Library versions differ: " + ", ".join(diff) if diff
                                                       else " Same library versions as the references."))
    print("\nsame board")


if __name__ == "__main__":
    main()
