#!/usr/bin/env python3
"""Board design tool: a small web server around the sea-board pipeline in ../src.

All paths are relative to this file (the project root is its parent folder):
  ../src    pipeline scripts (make_tiles.py, make_art.py, compose_board.py), run unchanged
  ../out    the main project's output (read only, for "Import main board")
  ../.venv  Python used for the pipeline (falls back to the Python running this server)
This tool never writes into ../src or ../out:
  state/config.yaml   the tool's own copy of the config (edited from the menubar)
  work/runs/<id>/     output of a generator run (its own output_dir)
  designs/<name>/     an editable design: design.json, labels.bin, water.bin, art
  designs/<name>/export/   composed board (svg, pdf, preview) made from the design

Run:  ../.venv/bin/python server.py [--port 8765] [--host 127.0.0.1]   (or ./run.sh)
Override with BOARD_SRC, BOARD_MAIN_OUT, BOARD_PY if the layout differs.
"""
import argparse
import colorsys
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import numpy as np
import yaml
from PIL import Image

WEB = Path(__file__).resolve().parent
ROOT = WEB.parent
SRC = Path(os.environ.get("BOARD_SRC", ROOT / "src")).resolve()
MAIN_OUT = Path(os.environ.get("BOARD_MAIN_OUT", ROOT / "out")).resolve()
_venv_py = ROOT / ".venv/bin/python"
PY = os.environ.get("BOARD_PY") or (str(_venv_py) if _venv_py.exists() else sys.executable)
STATE = WEB / "state"
WORK = WEB / "work"
RUNS = WORK / "runs"
DESIGNS = WEB / "designs"
STATIC = WEB / "static"
MY_CONFIG = STATE / "config.yaml"
MAIN_CONFIG = SRC / "config.yaml"

# read-only use of the shared helpers; never write .pyc files into ../src
sys.dont_write_bytecode = True
sys.path.append(str(SRC))

# environment for pipeline subprocesses: numba cache and bytecode stay out of ../src
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONUNBUFFERED="1",
           NUMBA_CACHE_DIR=str(WORK / "numba_cache"))

Image.MAX_IMAGE_PIXELS = None
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

WEBTOOL_DEFAULTS = {
    "frame": {"top": 0, "right": 0, "bottom": 0, "left": 0},
    "frame_color": "#16324a",
    "snap_mm": 1.0,
}
WEBTOOL_COMMENTS = {
    "webtool": "Settings of the design tool only (the pipeline ignores them)",
    "webtool.frame": "Empty border around the map for fields (mm). The map shrinks to fit; regenerate after changing",
    "webtool.frame.top": "frame above the map (mm)",
    "webtool.frame.right": "frame right of the map (mm)",
    "webtool.frame.bottom": "frame below the bottom panel (mm)",
    "webtool.frame.left": "frame left of the map (mm)",
    "webtool.frame_color": "colour of the frame",
    "webtool.snap_mm": "fields snap to this grid (mm); 0 = off",
}


# words on the board; the page gets them through /api/state
BOARD_TEXT = {
    "en": {"days": ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
           "day_names": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
           "legend": ["Canal", "Strait", "Sail around the world"]},
    "nl": {"days": ["MA", "DI", "WO", "DO", "VR", "ZA", "ZO"],
           "day_names": ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"],
           "legend": ["Kanaal", "Zeestraat", "Rond de wereld varen"]},
}
DESIGN_VERSION = 2      # 2: day track and legend are fields


# ------------------------------------------------------------------ config
def load_yaml(path):
    return yaml.safe_load(Path(path).read_text())


def main_config():
    return load_yaml(MAIN_CONFIG)


def deep_defaults(cfg, defaults):
    for k, v in defaults.items():
        if isinstance(v, dict):
            cfg[k] = deep_defaults(cfg.get(k) if isinstance(cfg.get(k), dict) else {}, v)
        elif k not in cfg:
            cfg[k] = v
    return cfg


def my_config():
    if not MY_CONFIG.exists():
        STATE.mkdir(parents=True, exist_ok=True)
        save_my_config(main_config())
    cfg = load_yaml(MY_CONFIG)
    # the main project keeps adding settings: take over keys we do not have yet
    try:
        main = main_config()
        fill_missing(cfg, main)
        for k in ("data_dir", "output_dir"):    # folder paths follow the main config, not the copy
            if k in main:
                cfg[k] = rel_src(main[k])
    except (OSError, yaml.YAMLError):
        pass
    cfg["webtool"] = deep_defaults(cfg.get("webtool") or {}, WEBTOOL_DEFAULTS)
    return cfg


def fill_missing(cfg, main):
    for k, v in main.items():
        if k not in cfg:
            cfg[k] = v
        elif isinstance(v, dict) and isinstance(cfg[k], dict):
            fill_missing(cfg[k], v)
    return cfg


def save_my_config(cfg):
    STATE.mkdir(parents=True, exist_ok=True)
    cfg = dict(cfg)
    cfg["webtool"] = deep_defaults(cfg.get("webtool") or {}, WEBTOOL_DEFAULTS)
    head = ("# Design tool copy of ../src/config.yaml (edited from the web menubar).\n"
            "# The original stays untouched; comments live in the original.\n")
    MY_CONFIG.write_text(head + yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True, width=120))


def strip_comment(rest):
    quote = None
    for i, ch in enumerate(rest):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#" and (i == 0 or rest[i - 1].isspace()):
            return rest[i + 1:].strip()
    return ""


def config_comments(text):
    """Map dotted config keys to the comments written next to (or above) them."""
    out, stack, pending = {}, [], []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#"):
            pending.append(s.lstrip("#").strip())
            continue
        if not s:
            pending = []
            continue
        m = re.match(r"^(\s*)([A-Za-z_]\w*):(.*)$", line)
        if m:
            ind, key, rest = len(m.group(1)), m.group(2), m.group(3)
            while stack and stack[-1][0] >= ind:
                stack.pop()
            path = ".".join([k for _, k in stack] + [key])
            stack.append((ind, key))
            parts = [p for p in pending if p] + ([strip_comment(rest)] if strip_comment(rest) else [])
            if parts:
                out[path] = " ".join(parts)
            pending = []
            continue
        m = re.match(r"^\s*-\s*\{\s*name:\s*([^,]+),.*$", line)
        if m:
            c = strip_comment(line.split("}", 1)[-1]) if "}" in line else ""
            if c:
                out["passages." + m.group(1).strip()] = c
        pending = []
    out.update(WEBTOOL_COMMENTS)
    return out


def run_config(cfg, out_dir):
    """Config handed to the pipeline: board shrunk by the frame, own output_dir."""
    rc = json.loads(json.dumps(cfg))
    fr = (cfg.get("webtool") or {}).get("frame") or {}
    rc["board"]["width_mm"] = float(cfg["board"]["width_mm"]) - float(fr.get("left", 0)) - float(fr.get("right", 0))
    rc["board"]["height_mm"] = float(cfg["board"]["height_mm"]) - float(fr.get("top", 0)) - float(fr.get("bottom", 0))
    rc["output_dir"] = rel_src(out_dir)
    rc["data_dir"] = rel_src(data_path(cfg))
    return rc


def rel(path):
    """Path relative to this folder (stored in design.json so the tree can move)."""
    try:
        return str(Path(path).resolve().relative_to(WEB))
    except ValueError:
        return str(path)


def rel_src(path):
    """Path as written into configs for the pipeline: relative to ../src, where its scripts run."""
    p = Path(path)
    if not p.is_absolute():
        return str(path)
    return os.path.relpath(p.resolve(), SRC)


def rel_paths(cfg):
    """A config with its folder settings made relative to ../src."""
    cfg = json.loads(json.dumps(cfg))
    for k in ("data_dir", "output_dir"):
        if cfg.get(k):
            cfg[k] = rel_src(cfg[k])
    return cfg


def data_path(cfg):
    """Natural Earth folder: data_dir from the config (relative = from ../src, like the pipeline).
    When that folder is missing (e.g. an absolute path from another machine), use ../data/natural_earth."""
    p = Path(cfg.get("data_dir") or "../data/natural_earth")
    p = p if p.is_absolute() else (SRC / p).resolve()
    local = ROOT / "data/natural_earth"
    return p if p.exists() or not local.exists() else local


def check_data(cfg):
    d = data_path(cfg)
    if not (d / "ne_50m_land").exists():
        raise RuntimeError(f"Natural Earth data not found in {d}. Run ./setup.sh (or "
                           f"python ../src/fetch_data.py --set data_dir={ROOT / 'data/natural_earth'}).")
    return d


# ------------------------------------------------------------------ jobs
class Job:
    def __init__(self, kind, title):
        self.id = f"{int(time.time() * 1000):x}"
        self.kind, self.title = kind, title
        self.status, self.log, self.result, self.error = "running", [], None, None
        self.started, self.ended, self.proc = time.time(), None, None
        self.cancelled = False

    def say(self, msg):
        for part in str(msg).replace("\r", "\n").split("\n"):
            if part.strip():
                self.log.append(part.rstrip())
        del self.log[:-2000]

    def as_dict(self, since=0):
        return {"id": self.id, "kind": self.kind, "title": self.title, "status": self.status,
                "log": self.log[since:], "log_len": len(self.log), "result": self.result,
                "error": self.error, "started": self.started, "ended": self.ended}


JOB_LOCK = threading.Lock()
CURRENT_JOB = [None]


def start_job(kind, title, fn):
    with JOB_LOCK:
        cur = CURRENT_JOB[0]
        if cur and cur.status == "running":
            raise ApiError(409, f"another job is running: {cur.title}")
        job = Job(kind, title)
        CURRENT_JOB[0] = job

    def target():
        try:
            job.result = fn(job)
            job.status = "done"
            job.say("finished")
        except Exception as e:      # noqa: BLE001 - report everything to the UI
            job.status = "cancelled" if job.cancelled else "error"
            job.error = str(e)
            job.say(traceback.format_exc() if not job.cancelled else "cancelled")
        job.ended = time.time()

    threading.Thread(target=target, daemon=True).start()
    return job


def run_cmd(job, args, cwd=SRC):
    job.say("$ " + " ".join(str(a) for a in args))
    proc = subprocess.Popen([str(a) for a in args], cwd=str(cwd), env=ENV, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    job.proc = proc
    for line in proc.stdout:
        if "FutureWarning" in line or "should be kept in float32" in line or "deprecate(" in line:
            continue
        job.say(line)
    rc = proc.wait()
    job.proc = None
    if job.cancelled:
        raise RuntimeError("cancelled")
    if rc != 0:
        raise RuntimeError(f"{Path(str(args[1])).name} failed (exit code {rc})")


# ------------------------------------------------------------------ designs
def sea_color(i):
    r, g, b = colorsys.hls_to_rgb((i * 0.618) % 1.0, 0.62, 0.45)
    return "#%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255))


def design_dir(name):
    if not NAME_RE.match(name or ""):
        raise ApiError(400, "design names may only use letters, digits, '.', '_' and '-'")
    return DESIGNS / name


def make_display_art(d):
    src = d / "art.png"
    if not src.exists():
        return
    im = Image.open(src).convert("RGB")
    if im.width > 4096:
        im = im.resize((4096, round(im.height * 4096 / im.width)), Image.LANCZOS)
    im.save(d / "art.jpg", quality=88)


def proj_for(board):
    from board_common import Projection
    return Projection({"map": {"projection": board["projection"], "center_lon": board["center_lon"],
                               "lat_north": board["lat_north"], "lat_south": board["lat_south"]},
                       "board": {"width_mm": board["width_mm"], "height_mm": board["height_mm"]}})


def config_passages(cfg, proj):
    out = []
    for p in cfg.get("passages") or []:
        ax, ay = proj.forward(*p["a"])
        bx, by = proj.forward(*p["b"])
        out.append({"name": p["name"], "kind": p["kind"], "enabled": bool(p.get("enabled", True)),
                    "source": "config", "a_lonlat": list(p["a"]), "b_lonlat": list(p["b"]),
                    "a_mm": [round(float(ax), 2), round(float(ay), 2)],
                    "b_mm": [round(float(bx), 2), round(float(by), 2)]})
    return out


def build_design(job, name, out_dir, cfg, frame, total_w, total_h, source, run_dir=None):
    """Turn a pipeline output dir (tiles.json + labels.npy + art) into an editable design."""
    from board_common import rasterize, read_rings
    d = design_dir(name)
    tj = json.loads((out_dir / "tiles/tiles.json").read_text())
    lab = np.load(out_dir / "tiles/labels.npy").astype(np.int16)
    H, W = lab.shape
    b = tj["board"]
    ppm = W / float(b["width_mm"])
    proj = proj_for(b)
    job.say(f"design '{name}': raster {W}x{H} px, {int(lab.max())} tiles; computing water mask")
    data = data_path(cfg)

    def land_rings():
        for shp in ("ne_50m_land/ne_50m_land.shp",
                    "ne_50m_antarctic_ice_shelves_polys/ne_50m_antarctic_ice_shelves_polys.shp"):
            for _, rings in read_rings(data / shp):
                yield None, rings
    land = rasterize(land_rings(), proj, ppm, (H, W), lambda k: 1) > 0
    water = (~land) | (lab > 0)

    d.mkdir(parents=True, exist_ok=True)
    (d / "labels.bin").write_bytes(lab.astype("<i2").tobytes())
    (d / "water.bin").write_bytes(water.astype(np.uint8).tobytes())
    art = None
    for cand in ("art.png", "guide.png"):
        if (out_dir / "art" / cand).exists():
            art = out_dir / "art" / cand
            break
    if art:
        job.say(f"art: {art}")
        shutil.copy(art, d / "art.png")
        make_display_art(d)

    seas = []
    for i, s in enumerate(sorted(tj["seas"], key=lambda s: s["name"])):
        seas.append({"name": s["name"], "name_nl": s.get("name_nl") or s["name"], "class": s["class"],
                     "color": sea_color(i), "label_mm": s.get("label_mm"), "label_size_mm": None,
                     "show_label": True})
    tiles = [{"id": t["id"], "sea": t["sea"], "pawn_mm": t["pawn_mm"], "pawn_manual": False,
              "pinned": False, "note": ""} for t in tj["tiles"]]
    design = {
        "version": 1, "name": name, "created": time.strftime("%Y-%m-%d %H:%M:%S"), "source": source,
        "run_dir": rel(run_dir) if run_dir else None,
        "board": {"width_mm": total_w, "height_mm": total_h, "frame": frame,
                  "inner_width_mm": b["width_mm"], "inner_height_mm": b["height_mm"],
                  "map_height_mm": b["map_height_mm"], "panel_height_mm": b["panel_height_mm"],
                  "projection": b["projection"], "center_lon": b["center_lon"],
                  "lat_north": b["lat_north"], "lat_south": b["lat_south"]},
        "raster": {"W": W, "H": H, "ppm": ppm},
        "config": cfg,
        "tiles": tiles, "seas": seas, "passages": config_passages(cfg, proj), "fields": [],
        "has_art": art is not None,
    }
    upgrade_design(design, my_config())
    (d / "design.json").write_text(json.dumps(design, indent=1, ensure_ascii=False))
    set_state(last_design=name)
    job.say(f"design saved: {d}")
    return {"design": name}


def default_board_fields(board, cfg):
    """The seven day squares and the legend, as fields at their default place in the bottom panel."""
    fr, dt = board["frame"], cfg["day_track"]
    W, PH = float(board["inner_width_mm"]), float(board["panel_height_mm"])
    middle = float(fr["top"]) + float(board["map_height_mm"]) + PH / 2
    size = min(float(dt["space_mm"]), PH - 6) if PH > 5 else 0
    gap, weekend_gap = float(dt["gap_mm"]), float(dt["weekend_gap_mm"])
    days = []
    if size > 0:
        x = float(fr["left"]) + (W - (7 * size + 5 * gap + weekend_gap)) / 2 + size / 2
        for i in range(7):
            # label / sublabel None = the day's name in the board language, until renamed
            days.append({"id": f"day-{i}", "kind": "day", "group": "day-track", "day": i,
                         "label": None, "sublabel": None, "shape": "rounded",
                         "x": round(x, 2), "y": round(middle, 2), "w": round(size, 2), "h": round(size, 2),
                         "rotation": 0, "color": dt["weekend_color"] if i >= 5 else dt["workday_color"],
                         "text_color": dt["text_color"], "opacity": 1, "notes": ""})
            x += size + (weekend_gap if i == 4 else gap)
    legend = {"id": "legend", "kind": "legend", "group": None, "shape": "legend", "label": "",
              "x": round(float(fr["left"]) + W - 40, 2), "y": round(middle, 2), "w": 62, "h": 18,
              "rotation": 0, "opacity": 1, "notes": ""}
    return {"days": days, "legend": legend}


def upgrade_design(design, cfg):
    """Older designs had the day track and legend painted on: give them fields instead (in memory only)."""
    if design.get("version", 1) >= DESIGN_VERSION:
        return design
    fields = design.get("fields") or []
    if design["board"]["panel_height_mm"] > 5:
        new = default_board_fields(design["board"], cfg)
        fields = new["days"] + [new["legend"]] + fields     # first = underneath the user's own fields
    design["fields"], design["version"] = fields, DESIGN_VERSION
    return design


def list_designs():
    out = []
    if DESIGNS.exists():
        for d in DESIGNS.iterdir():
            f = d / "design.json"
            if f.exists():
                try:
                    meta = json.loads(f.read_text())
                except ValueError:
                    continue
                out.append({"name": d.name, "modified": f.stat().st_mtime, "source": meta.get("source"),
                            "tiles": len(meta.get("tiles", [])), "fields": len(meta.get("fields", []))})
    return sorted(out, key=lambda x: -x["modified"])


def get_state():
    f = STATE / "state.json"
    return json.loads(f.read_text()) if f.exists() else {}


def set_state(**kw):
    s = get_state()
    s.update(kw)
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "state.json").write_text(json.dumps(s, indent=1))


# ------------------------------------------------------------------ jobs: generate / import / art
def same_geometry(a, b):
    keys = [("board", "width_mm"), ("board", "height_mm"), ("map", "projection"), ("map", "center_lon"),
            ("map", "lat_north"), ("map", "lat_south")]
    return all(float(a[s][k]) == float(b[s][k]) if k != "projection" else a[s][k] == b[s][k] for s, k in keys)


def job_generate(name, with_guide):
    cfg = my_config()
    run_id = time.strftime("%Y%m%d-%H%M%S")
    run_dir = RUNS / run_id
    design_dir(name)

    def fn(job):
        check_data(cfg)
        run_dir.mkdir(parents=True, exist_ok=True)
        rc = run_config(cfg, run_dir)
        cfg_path = run_dir / "config.yaml"
        cfg_path.write_text(yaml.safe_dump(rc, sort_keys=False, allow_unicode=True, width=120))
        fr = cfg["webtool"]["frame"]
        job.say(f"run {run_id}: board {cfg['board']['width_mm']}x{cfg['board']['height_mm']} mm, "
                f"map area {rc['board']['width_mm']}x{rc['board']['height_mm']} mm (frame {fr})")
        run_cmd(job, [PY, SRC / "make_tiles.py", "--config", cfg_path])
        (run_dir / "art").mkdir(exist_ok=True)
        main_rc = main_config()
        main_art = MAIN_OUT / "art/art.png"
        if main_art.exists() and same_geometry(rc, main_rc):
            job.say("reusing the main project's painted art (same geometry)")
            shutil.copy(main_art, run_dir / "art/art.png")
        elif with_guide:
            run_cmd(job, [PY, SRC / "make_art.py", "guide", "--config", cfg_path])
        return build_design(job, name, run_dir, rc, fr, float(cfg["board"]["width_mm"]),
                            float(cfg["board"]["height_mm"]), f"generated (run {run_id})", run_dir)
    return start_job("generate", f"Generate tiles -> {name}", fn)


def job_import_main(name):
    design_dir(name)

    def fn(job):
        if not (MAIN_OUT / "tiles/tiles.json").exists():
            raise RuntimeError(f"no tiles in {MAIN_OUT}/tiles yet")
        cfg = rel_paths(main_config())
        tj = json.loads((MAIN_OUT / "tiles/tiles.json").read_text())
        b = tj["board"]
        job.say(f"importing the main project's board from {MAIN_OUT} ({len(tj['tiles'])} tiles)")
        frame = {"top": 0, "right": 0, "bottom": 0, "left": 0}
        return build_design(job, name, MAIN_OUT, cfg, frame, float(b["width_mm"]), float(b["height_mm"]),
                            f"imported from {os.path.relpath(MAIN_OUT, WEB)}")
    return start_job("import", f"Import main board -> {name}", fn)


def design_run_dir(design):
    """A run dir with a config that matches the design geometry (made on demand)."""
    rd = design.get("run_dir")
    if rd and (WEB / rd / "config.yaml").exists():
        return WEB / rd
    run_dir = RUNS / ("for-" + design["name"] + "-" + time.strftime("%Y%m%d-%H%M%S"))
    (run_dir / "art").mkdir(parents=True, exist_ok=True)
    rc = json.loads(json.dumps(design["config"]))
    rc["board"]["width_mm"] = design["board"]["inner_width_mm"]
    rc["board"]["height_mm"] = design["board"]["inner_height_mm"]
    rc["output_dir"] = rel_src(run_dir)
    rc["data_dir"] = rel_src(data_path(rc))
    (run_dir / "config.yaml").write_text(yaml.safe_dump(rc, sort_keys=False, allow_unicode=True, width=120))
    return run_dir


def job_art(name, step, strength=None):
    d = design_dir(name)
    design = json.loads((d / "design.json").read_text())

    def fn(job):
        run_dir = design_run_dir(design)
        cfg_path = run_dir / "config.yaml"
        rc = load_yaml(cfg_path)
        # art settings follow the current menubar config
        rc["art"] = my_config()["art"]
        rc["data_dir"] = rel_src(check_data(rc))
        if strength is not None:
            rc["art"]["strength"] = float(strength)
        cfg_path.write_text(yaml.safe_dump(rc, sort_keys=False, allow_unicode=True, width=120))
        run_cmd(job, [PY, SRC / "make_art.py", step, "--config", cfg_path])
        src = run_dir / "art" / ("art.png" if step == "full" else "guide.png")
        if step in ("guide", "full") and src.exists():
            shutil.copy(src, d / "art.png")
            make_display_art(d)
            design["has_art"] = True
            design["run_dir"] = rel(run_dir)
            cur = json.loads((d / "design.json").read_text())
            cur["has_art"], cur["run_dir"] = True, rel(run_dir)
            (d / "design.json").write_text(json.dumps(cur, indent=1, ensure_ascii=False))
        return {"design": name, "step": step,
                "samples": sorted(p.name for p in (run_dir / "art/samples").glob("*_sheet.jpg"))
                if step == "samples" else None, "run_dir": rel(run_dir)}
    return start_job("art", f"Art ({step}) for {name}", fn)


# ------------------------------------------------------------------ export
def chaikin(pts, iterations=3, closed=False):
    for _ in range(iterations):
        if len(pts) < 3:
            return pts
        a = pts if closed else pts[:-1]
        b = np.roll(pts, -1, axis=0) if closed else pts[1:]
        q, r = 0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b
        mid = np.empty((2 * len(a), 2))
        mid[0::2], mid[1::2] = q, r
        pts = mid if closed else np.vstack([pts[:1], mid, pts[-1:]])
    return pts


def chain_segments(segs):
    inc = defaultdict(list)
    for i, (a, b) in enumerate(segs):
        inc[a].append(i)
        inc[b].append(i)
    used = np.zeros(len(segs), bool)
    lines = []

    def walk(start_v, seg):
        line, v = [start_v], start_v
        while True:
            used[seg] = True
            a, b = segs[seg]
            v = b if a == v else a
            line.append(v)
            if len(inc[v]) != 2:
                return line, False
            nxt = [s for s in inc[v] if not used[s]]
            if not nxt:
                return line, True
            seg = nxt[0]

    for v, ss in inc.items():
        if len(ss) != 2:
            for s in ss:
                if not used[s]:
                    lines.append(walk(v, s))
    for s in range(len(segs)):
        if not used[s]:
            lines.append(walk(segs[s][0], s))
    return lines


def analyse(lab, ppm, design, cfg):
    """Neighbours, wraps, passages, areas, inscribed circles for an edited label raster."""
    from scipy import ndimage
    H, W = lab.shape
    ids = sorted(int(t["id"]) for t in design["tiles"])
    adj = defaultdict(int)
    for a, b in ((lab[:, :-1], lab[:, 1:]), (lab[:-1, :], lab[1:, :])):
        m = (a > 0) & (b > 0) & (a != b)
        for x, y in zip(a[m].tolist(), b[m].tolist()):
            adj[(min(x, y), max(x, y))] += 1
    edges = {k: "sea" for k in adj}
    wraps = []
    a, b = lab[:, 0], lab[:, -1]
    runs = defaultdict(list)
    for r in np.flatnonzero((a > 0) & (b > 0)):
        runs[(int(a[r]), int(b[r]))].append(r)
    min_wrap = float(cfg["tiles"].get("min_wrap_edge_mm", 4)) * ppm
    for (x, y), rows in runs.items():
        if x == y or len(rows) < min_wrap:
            continue
        edges.setdefault((min(x, y), max(x, y)), "wrap")
        wraps.append({"left": x, "right": y, "y_mm": round((rows[len(rows) // 2] + 0.5) / ppm, 2)})
    passages = []
    if (lab > 0).any():
        nearest = ndimage.distance_transform_edt(lab == 0, return_distances=False, return_indices=True)
    for p in design.get("passages", []):
        if not p.get("enabled", True):
            continue
        ends = []
        for x, y in (p["a_mm"], p["b_mm"]):
            r, c = min(max(int(y * ppm), 0), H - 1), min(max(int(x * ppm), 0), W - 1)
            rr, cc = nearest[0][r, c], nearest[1][r, c]
            ends.append((int(lab[rr, cc]), np.hypot(rr - r, cc - c) / ppm))
        (ta, da), (tb, db) = ends
        if max(da, db) > 3 or ta == tb or ta == 0 or tb == 0:
            continue
        key = (min(ta, tb), max(ta, tb))
        natural = key in adj
        if not natural:
            edges[key] = p["kind"]
        passages.append({"name": p["name"], "kind": p["kind"], "tiles": [ta, tb], "already_connected": natural,
                         "a_mm": p["a_mm"], "b_mm": p["b_mm"], "drawn": p["kind"] != "strait" or not natural})
    nb = defaultdict(set)
    for x, y in edges:
        nb[x].add(y)
        nb[y].add(x)
    pad = np.pad(lab, 1, constant_values=-1)
    inner = ((pad[1:-1, 1:-1] == pad[:-2, 1:-1]) & (pad[1:-1, 1:-1] == pad[2:, 1:-1])
             & (pad[1:-1, 1:-1] == pad[1:-1, :-2]) & (pad[1:-1, 1:-1] == pad[1:-1, 2:]) & (lab > 0))
    dt = ndimage.distance_transform_edt(inner)
    area = np.bincount(lab.ravel().clip(0), minlength=max(ids + [0]) + 1)
    best = ndimage.maximum(dt, lab, index=ids) if ids else []
    return {"edges": edges, "wraps": wraps, "passages": passages, "nb": nb, "area": area,
            "inscribed": dict(zip(ids, [float(v) for v in best]))}


def borders_of(lab, ppm, sea_of):
    H, W = lab.shape
    reg = sea_of[lab]
    segs = {"tile": [], "region": []}
    W1 = W + 1
    a, b = lab[:, :-1], lab[:, 1:]
    m = (a > 0) & (b > 0) & (a != b)
    rr, cc = np.nonzero(m)
    kind = np.where(reg[:, :-1][m] != reg[:, 1:][m], "region", "tile")
    for r, c, k in zip(rr.tolist(), cc.tolist(), kind):
        segs[k].append((r * W1 + c + 1, (r + 1) * W1 + c + 1))
    a, b = lab[:-1, :], lab[1:, :]
    m = (a > 0) & (b > 0) & (a != b)
    rr, cc = np.nonzero(m)
    kind = np.where(reg[:-1, :][m] != reg[1:, :][m], "region", "tile")
    for r, c, k in zip(rr.tolist(), cc.tolist(), kind):
        segs[k].append(((r + 1) * W1 + c, (r + 1) * W1 + c + 1))
    out = []
    for k, ss in segs.items():
        for line, closed in chain_segments(ss):
            v = np.array(line)
            pts = np.column_stack([v % W1, v // W1]).astype(float) / ppm
            if closed:
                pts = pts[:-1]
            pts = chaikin(pts, 3, closed)
            out.append({"kind": k, "closed": bool(closed), "pts": np.round(pts, 2).tolist()})
    return out


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def resolve_field(f, text):
    """A field with the day names filled in where they were not renamed."""
    f, i = dict(f), f.get("day")
    if i is not None:
        for key, words in (("label", "days"), ("sublabel", "day_names")):
            if f.get(key) is None:
                f[key] = text[words][i]
    return f


def legend_svg(f, font, ink, text):
    colour = esc(f.get("text_color") or ink)
    k = min(float(f["w"]) / 62, float(f["h"]) / 18)
    op = float(f["opacity"] if f.get("opacity") is not None else 1)
    g = [f'<g transform="translate({f["x"]:.2f},{f["y"]:.2f}) rotate({float(f.get("rotation") or 0):.1f}) '
         f'scale({k:.4f})" opacity="{op}">']
    for i, dash in enumerate(("2.2,1.4", "0.6,1.2", None)):
        y = -6 + 6 * i
        if dash:
            g.append(f'<line x1="-30" y1="{y}" x2="-20" y2="{y}" stroke="{colour}" stroke-width="0.9" '
                     f'stroke-dasharray="{dash}"/>')
        else:
            g.append(f'<path d="M-30,{y - 2} L-26.8,{y} L-30,{y + 2} Z" fill="{colour}"/>')
        g.append(f'<text x="-17" y="{y + 1.3}" font-family="{esc(font)}" font-size="3.6" fill="{colour}">'
                 f'{esc(text["legend"][i])}</text>')
    g.append("</g>")
    return "\n".join(g)


def field_svg(f, font, ink):
    x, y = float(f.get("x", 0)), float(f.get("y", 0))
    w, h = float(f.get("w", 20)), float(f.get("h", 20))
    rot = float(f.get("rotation", 0) or 0)
    fill = f.get("color") or "#c8743a"
    stroke = f.get("stroke") or ink
    op = float(f.get("opacity", 1) if f.get("opacity") is not None else 1)
    shape = f.get("shape", "rect")
    style = f'fill="{esc(fill)}" fill-opacity="{op}" stroke="{esc(stroke)}" stroke-width="0.6"'
    g = [f'<g transform="translate({x:.2f},{y:.2f}) rotate({rot:.1f})">']
    if shape == "circle":
        g.append(f'<ellipse cx="0" cy="0" rx="{w / 2:.2f}" ry="{h / 2:.2f}" {style}/>')
    elif shape in ("hex", "diamond"):
        if shape == "hex":
            pts = [(w / 2 * np.cos(np.radians(60 * i + 30)), h / 2 * np.sin(np.radians(60 * i + 30))) for i in range(6)]
        else:
            pts = [(0, -h / 2), (w / 2, 0), (0, h / 2), (-w / 2, 0)]
        g.append('<polygon points="' + " ".join(f"{px:.2f},{py:.2f}" for px, py in pts) + f'" {style}/>')
    else:
        rx = min(w, h) * (0.18 if shape == "rounded" else 0.04)
        g.append(f'<rect x="{-w / 2:.2f}" y="{-h / 2:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{rx:.2f}" {style}/>')
    label = str(f.get("label") or "")
    sub = str(f.get("sublabel") or "")
    tc = f.get("text_color") or ink
    if label:
        lines = label.split("\n")
        if sub:     # big label with a small line under it
            fs = float(f.get("font_mm") or round(min(w, h) * 0.3, 1))
            base = h * 0.02 - (len(lines) - 1) * fs * 1.2
        else:
            fs = float(f.get("font_mm") or max(min(w, h) * 0.28, 1.5))
            base = fs * 0.35 - (len(lines) - 1) * fs * 0.6
        for i, ln in enumerate(lines):
            g.append(f'<text x="0" y="{base + i * fs * 1.2:.2f}" font-family="{esc(font)}" '
                     f'font-size="{fs:.2f}" font-weight="bold" text-anchor="middle" fill="{esc(tc)}">{esc(ln)}</text>')
    if sub:
        g.append(f'<text x="0" y="{h * (0.3 if label else 0.05):.2f}" font-family="{esc(font)}" '
                 f'font-size="{min(w, h) * 0.13:.1f}" font-style="italic" text-anchor="middle" '
                 f'fill="{esc(tc)}" fill-opacity="0.85">{esc(sub)}</text>')
    g.append("</g>")
    return "\n".join(g)


def job_export(name, png):
    d = design_dir(name)
    design = json.loads((d / "design.json").read_text())

    def fn(job):
        cfg = my_config()
        upgrade_design(design, cfg)
        text = BOARD_TEXT.get(cfg["compose"]["language"], BOARD_TEXT["en"])
        fields = [resolve_field(f, text) for f in design.get("fields", []) if not f.get("hidden")]
        W, H, ppm = design["raster"]["W"], design["raster"]["H"], design["raster"]["ppm"]
        lab = np.frombuffer((d / "labels.bin").read_bytes(), dtype="<i2").reshape(H, W).astype(np.int32)
        exp = d / "export"
        (exp / "tiles").mkdir(parents=True, exist_ok=True)
        (exp / "art").mkdir(parents=True, exist_ok=True)
        b = design["board"]
        job.say(f"analysing {len(design['tiles'])} tiles")
        an = analyse(lab, ppm, design, cfg)
        seas = design["seas"]
        sea_idx = {s["name"]: i for i, s in enumerate(seas)}
        max_id = int(max([t["id"] for t in design["tiles"]] + [lab.max(), 0]))
        sea_of = np.full(max_id + 1, -1, np.int32)
        for t in design["tiles"]:
            sea_of[t["id"]] = sea_idx.get(t["sea"], -1)
        job.say("tracing borders")
        borders = borders_of(lab, ppm, sea_of)
        c = cfg["compose"]
        tiles = []
        for t in sorted(design["tiles"], key=lambda t: t["id"]):
            tid = int(t["id"])
            tiles.append({"id": tid, "sea": t["sea"], "area_mm2": round(float(an["area"][tid]) / ppm ** 2, 1),
                          "pawn_mm": t["pawn_mm"],
                          "inscribed_diameter_mm": round(2 * an["inscribed"].get(tid, 0) / ppm, 1),
                          "neighbours": sorted(int(u) for u in an["nb"][tid]),
                          **({"note": t["note"]} if t.get("note") else {})})
        out_seas = []
        for s in seas:
            st = [t["id"] for t in design["tiles"] if t["sea"] == s["name"]]
            if not st or not s.get("show_label", True) or not s.get("label_mm"):
                continue
            ocean = s["class"] == "ocean"
            size = s.get("label_size_mm") or (c["ocean_label_mm"] if ocean else c["sea_label_mm"])
            out_seas.append({"name": s["name"], "name_nl": s.get("name_nl") or s["name"], "class": s["class"],
                             "tiles": st, "label_mm": s["label_mm"], "label_size_mm": size,
                             "label_spacing_mm": round((0.2 if ocean else 0.05) * size, 2)})
        tj = {"board": {"width_mm": b["inner_width_mm"], "height_mm": b["inner_height_mm"],
                        "map_height_mm": b["map_height_mm"], "panel_height_mm": b["panel_height_mm"],
                        "projection": b["projection"], "center_lon": b["center_lon"],
                        "lat_north": b["lat_north"], "lat_south": b["lat_south"], "wraps_east_west": True,
                        "pawn_diameter_mm": cfg["tiles"]["pawn_diameter_mm"],
                        "frame_mm": b["frame"], "total_width_mm": b["width_mm"], "total_height_mm": b["height_mm"]},
              "tiles": tiles, "seas": out_seas,
              "edges": [{"tiles": [int(x), int(y)], "kind": k} for (x, y), k in sorted(an["edges"].items())],
              "wraps": an["wraps"], "passages": an["passages"],
              "fields": fields,
              "fields_note": "field x/y are the centre in mm on the whole board (frame included); "
                             "everything else is in mm on the map area"}
        (exp / "tiles/borders.json").write_text(json.dumps(borders, ensure_ascii=False))
        for f in (exp / "art").glob("*.png"):
            f.unlink()
        art_choice = "none"
        if (d / "art.png").exists():
            os.symlink("../../art.png", exp / "art/art.png")    # relative link
            art_choice = "art"
        ecfg = json.loads(json.dumps(cfg))
        ecfg["output_dir"] = rel_src(exp)
        ecfg["data_dir"] = rel_src(data_path(ecfg))
        (exp / "config.yaml").write_text(yaml.safe_dump(ecfg, sort_keys=False, allow_unicode=True, width=120))
        # compose_board.py paints a fixed day track and legend into any panel higher than 5 mm. Here they are
        # fields, so it is told the panel has no height; the real height goes into the file afterwards.
        (exp / "tiles/tiles.json").write_text(json.dumps({**tj, "board": {**tj["board"], "panel_height_mm": 0}}))
        try:
            run_cmd(job, [PY, SRC / "compose_board.py", "--config", exp / "config.yaml", "--art", art_choice,
                          "--no-png"])
        finally:
            (exp / "tiles/tiles.json").write_text(json.dumps(tj, indent=1, ensure_ascii=False))
        job.say("adding frame and fields")
        inner = (exp / "board/board.svg").read_text()
        first, rest = inner.split("\n", 1)
        fr = b["frame"]
        TW, TH = float(b["width_mm"]), float(b["height_mm"])
        iw, ih = float(b["inner_width_mm"]), float(b["inner_height_mm"])
        ink = c["border_color"]
        parts = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
                 f'width="{TW}mm" height="{TH}mm" viewBox="0 0 {TW} {TH}">',
                 f'<rect width="{TW}" height="{TH}" fill="{esc(cfg["webtool"]["frame_color"])}"/>',
                 f'<svg x="{fr["left"]}" y="{fr["top"]}" width="{iw}" height="{ih}" viewBox="0 0 {iw} {ih}" '
                 f'overflow="hidden">', rest]
        if b["panel_height_mm"] > 5:
            y = fr["top"] + b["map_height_mm"]
            parts.append(f'<line x1="{fr["left"]}" y1="{y:.2f}" x2="{fr["left"] + iw}" y2="{y:.2f}" '
                         f'stroke="{esc(ink)}" stroke-width="0.6"/>')
        for f in fields:
            parts.append(legend_svg(f, c["font"], ink, text) if f.get("shape") == "legend"
                         else field_svg(f, c["font"], ink))
        parts.append("</svg>")
        svg = "\n".join(parts)
        (exp / "board.svg").write_text(svg)
        import cairosvg
        job.say("writing board.pdf")
        cairosvg.svg2pdf(bytestring=svg.encode(), write_to=str(exp / "board.pdf"))
        prev = cairosvg.svg2png(bytestring=svg.encode(), output_width=2400)
        import io
        Image.open(io.BytesIO(prev)).convert("RGB").save(exp / "board_preview.jpg", quality=88)
        files = ["board.pdf", "board.svg", "board_preview.jpg", "tiles/tiles.json", "tiles/borders.json"]
        if png:
            job.say(f"writing board.png at {c['print_dpi']} dpi (slow)")
            px = int(round(TW / 25.4 * c["print_dpi"]))
            cairosvg.svg2png(bytestring=svg.encode(), write_to=str(exp / "board.png"), output_width=px)
            files.append("board.png")
        job.say(f"export in {exp}")
        return {"design": name, "dir": rel(exp), "files": files, "stamp": int(time.time())}
    return start_job("export", f"Export {name}", fn)


# ------------------------------------------------------------------ http
class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


class Handler(BaseHTTPRequestHandler):
    server_version = "BoardTool/1"

    def log_message(self, fmt, *args):
        if "/api/jobs/current" in (args[0] if args else ""):
            return
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    # -- helpers
    def send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype=None, download=False):
        path = Path(path)
        if not path.is_file():
            raise ApiError(404, f"not found: {path.name}")
        ctype = ctype or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if path.suffix == ".js":
            ctype = "text/javascript"
        extra = {"Content-Disposition": f'attachment; filename="{path.name}"'} if download else None
        self.send(200, path.read_bytes(), ctype, extra)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def json_body(self):
        raw = self.body()
        return json.loads(raw) if raw else {}

    def handle_any(self, method):
        try:
            url = urlparse(self.path)
            parts = [unquote(p) for p in url.path.strip("/").split("/") if p]
            self.route(method, parts, url)
        except ApiError as e:
            self.send(e.code, {"error": str(e)})
        except Exception as e:      # noqa: BLE001
            traceback.print_exc()
            self.send(500, {"error": f"{type(e).__name__}: {e}"})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PUT(self):
        self.handle_any("PUT")

    # -- routes
    def route(self, method, p, url):
        if not p or p == ["index.html"]:
            return self.send_file(STATIC / "index.html", "text/html; charset=utf-8")
        if p[0] == "static":
            target = (STATIC / "/".join(p[1:])).resolve()
            if STATIC.resolve() not in target.parents:
                raise ApiError(403, "forbidden")
            return self.send_file(target)
        if p[0] != "api":
            raise ApiError(404, "not found")
        p = p[1:]
        if p == ["state"] and method == "GET":
            mtext = MAIN_CONFIG.read_text()
            cur = CURRENT_JOB[0]
            main_tiles = MAIN_OUT / "tiles/tiles.json"
            return self.send(200, {
                "config": my_config(), "main_config": yaml.safe_load(mtext), "comments": config_comments(mtext),
                "designs": list_designs(), "state": get_state(),
                "job": cur.as_dict() if cur else None,
                "main_board": {"exists": main_tiles.exists(),
                               "modified": main_tiles.stat().st_mtime if main_tiles.exists() else None},
                "board_text": BOARD_TEXT,
                "data_ok": (data_path(my_config()) / "ne_50m_land").exists(),
                "paths": {"src": os.path.relpath(SRC, WEB), "main_out": os.path.relpath(MAIN_OUT, WEB), "webtool": "."}})
        if p == ["config"] and method == "PUT":
            cfg = self.json_body()
            if not isinstance(cfg, dict) or "board" not in cfg:
                raise ApiError(400, "not a config")
            save_my_config(cfg)
            return self.send(200, {"ok": True, "config": my_config()})
        if p == ["config", "reset"] and method == "POST":
            req = self.json_body()
            cfg, main = my_config(), main_config()
            section = req.get("section")
            if section:
                if section in main:
                    cfg[section] = main[section]
                elif section == "webtool":
                    cfg["webtool"] = json.loads(json.dumps(WEBTOOL_DEFAULTS))
            else:
                main["webtool"] = cfg.get("webtool")
                cfg = main
            save_my_config(cfg)
            return self.send(200, {"ok": True, "config": my_config()})
        if p == ["board-fields"] and method == "POST":
            req = self.json_body()
            return self.send(200, default_board_fields(req["board"], req["config"]))
        if p[:1] == ["jobs"]:
            if p == ["jobs", "current"] and method == "GET":
                cur = CURRENT_JOB[0]
                since = int((dict(x.split("=") for x in url.query.split("&") if "=" in x)).get("since", 0))
                return self.send(200, {"job": cur.as_dict(since) if cur else None})
            if p == ["jobs", "cancel"] and method == "POST":
                cur = CURRENT_JOB[0]
                if cur and cur.status == "running":
                    cur.cancelled = True
                    if cur.proc:
                        cur.proc.terminate()
                return self.send(200, {"ok": True})
            if p == ["jobs"] and method == "POST":
                req = self.json_body()
                kind = req.get("kind")
                if kind == "generate":
                    job = job_generate(req["name"], req.get("guide", True))
                elif kind == "import":
                    job = job_import_main(req["name"])
                elif kind == "art":
                    job = job_art(req["name"], req.get("step", "guide"), req.get("strength"))
                elif kind == "export":
                    job = job_export(req["name"], bool(req.get("png")))
                else:
                    raise ApiError(400, f"unknown job kind {kind}")
                return self.send(200, {"job": job.as_dict()})
        if p == ["designs"] and method == "GET":
            return self.send(200, {"designs": list_designs()})
        if p[:1] == ["designs"] and len(p) >= 2:
            d = design_dir(p[1])
            rest = p[2:]
            if not rest and method == "GET":
                f = d / "design.json"
                if not f.is_file():
                    raise ApiError(404, f"unknown design: {p[1]}")
                set_state(last_design=p[1])
                return self.send(200, upgrade_design(json.loads(f.read_text()), my_config()))
            if not rest and method == "PUT":
                meta = self.json_body()
                if not (d / "labels.bin").exists() and not meta.get("_new"):
                    raise ApiError(404, "unknown design")
                meta.pop("_new", None)
                meta["name"] = p[1]
                meta["modified"] = time.strftime("%Y-%m-%d %H:%M:%S")
                d.mkdir(parents=True, exist_ok=True)
                tmp = d / "design.json.tmp"
                tmp.write_text(json.dumps(meta, indent=1, ensure_ascii=False))
                tmp.replace(d / "design.json")
                set_state(last_design=p[1])
                return self.send(200, {"ok": True})
            if rest == ["labels"] and method == "GET":
                return self.send_file(d / "labels.bin", "application/octet-stream")
            if rest == ["labels"] and method == "PUT":
                raw = self.body()
                meta = json.loads((d / "design.json").read_text())
                if len(raw) != meta["raster"]["W"] * meta["raster"]["H"] * 2:
                    raise ApiError(400, "labels size does not match the raster")
                (d / "labels.bin.tmp").write_bytes(raw)
                (d / "labels.bin.tmp").replace(d / "labels.bin")
                return self.send(200, {"ok": True})
            if rest == ["water"] and method == "GET":
                return self.send_file(d / "water.bin", "application/octet-stream")
            if rest == ["art.jpg"] and method == "GET":
                return self.send_file(d / "art.jpg", "image/jpeg")
            if rest == ["copy"] and method == "POST":
                to = design_dir(self.json_body()["to"])
                if to.exists():
                    raise ApiError(409, f"design '{to.name}' already exists")
                shutil.copytree(d, to, ignore=shutil.ignore_patterns("export"))
                return self.send(200, {"ok": True})
            if rest[:1] == ["export"] and method == "GET":
                target = (d / "export" / "/".join(rest[1:])).resolve()
                if (d / "export").resolve() not in target.parents:
                    raise ApiError(403, "forbidden")
                return self.send_file(target, download="download" in url.query)
            if rest[:1] == ["samples"] and method == "GET":
                meta = json.loads((d / "design.json").read_text())
                return self.send_file(WEB / meta["run_dir"] / "art/samples" / rest[1])
        raise ApiError(404, f"no route for {method} /api/{'/'.join(p)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    for p in (STATE, RUNS, DESIGNS, WORK / "numba_cache"):
        p.mkdir(parents=True, exist_ok=True)
    my_config()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"Board design tool on http://{a.host}:{a.port}  (pipeline: {SRC}, read-only)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
