"""Shared helpers: config loading, map projection, rasterising Natural Earth shapes."""
import argparse
import json
import math
from pathlib import Path

import numpy as np
import yaml

SRC_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SRC_DIR / "config.yaml"


def parse_args(description, extra=None):
    p = argparse.ArgumentParser(description=description)
    p.add_argument("--config", default=str(DEFAULT_CONFIG), help="path to config.yaml")
    p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                   help="override a config value, e.g. --set tiles.count=100 (repeatable)")
    if extra:
        extra(p)
    return p.parse_args()


def load_config(args):
    cfg = yaml.safe_load(Path(args.config).read_text())
    for item in args.set:
        key, _, value = item.partition("=")
        node = cfg
        parts = key.split(".")
        for k in parts[:-1]:
            node = node[k]
        node[parts[-1]] = yaml.safe_load(value)
    for key in ("output_dir", "data_dir"):
        cfg[key] = str((SRC_DIR / cfg[key]).resolve())      # relative = from src/; absolute stays as it is
    out = Path(cfg["output_dir"])
    out.mkdir(parents=True, exist_ok=True)
    return cfg


# ---------------------------------------------------------------- projection
class Projection:
    """Maps lon/lat to board millimetres. x=0 is the left edge, y=0 the top edge."""

    def __init__(self, cfg):
        m, b = cfg["map"], cfg["board"]
        self.kind = m["projection"]
        self.lon0 = float(m["center_lon"])
        self.lat_n = float(m["lat_north"])
        self.lat_s = float(m["lat_south"])
        self.width = float(b["width_mm"])
        self.board_h = float(b["height_mm"])
        self.R = self.width / (2 * math.pi)
        self.y_top = self._fy(np.radians(self.lat_n))
        self.map_h = self.R * (self.y_top - self._fy(np.radians(self.lat_s)))
        if self.map_h > self.board_h + 1e-6:
            raise SystemExit(
                f"Map is {self.map_h:.0f} mm tall but the board is {self.board_h:.0f} mm. "
                "Narrow map.lat_north/lat_south or make the board taller.")
        self.panel_h = self.board_h - self.map_h

    def _fy(self, phi):
        if self.kind == "miller":
            return 1.25 * np.log(np.tan(np.pi / 4 + 0.4 * phi))
        if self.kind == "equirectangular":
            return phi
        raise SystemExit(f"unknown projection {self.kind}")

    def _fy_inv(self, y):
        if self.kind == "miller":
            return 2.5 * np.arctan(np.exp(0.8 * y)) - 0.625 * np.pi
        return y

    def rel_lon(self, lon):
        """Longitude relative to the centre, wrapped to [-180, 180)."""
        return (np.asarray(lon, float) - self.lon0 + 180.0) % 360.0 - 180.0

    def forward(self, lon, lat, wrap=True):
        dl = self.rel_lon(lon) if wrap else np.asarray(lon, float) - self.lon0
        x = self.width / 2 + self.R * np.radians(dl)
        y = self.R * (self.y_top - self._fy(np.radians(np.asarray(lat, float))))
        return x, y

    def inverse(self, x, y):
        lon = self.lon0 + np.degrees((np.asarray(x, float) - self.width / 2) / self.R)
        lat = np.degrees(self._fy_inv(self.y_top - np.asarray(y, float) / self.R))
        return (lon + 180.0) % 360.0 - 180.0, lat


# ---------------------------------------------------------------- shapes
def read_rings(shp_path):
    """Yield (record, [ring arrays of lon/lat]) for every shape in a shapefile."""
    import shapefile
    r = shapefile.Reader(str(shp_path))
    for sr in r.iterShapeRecords():
        pts = np.asarray(sr.shape.points, float)
        if len(pts) == 0:
            continue
        parts = list(sr.shape.parts) + [len(pts)]
        rings = [pts[parts[i]:parts[i + 1]] for i in range(len(parts) - 1)]
        yield sr.record.as_dict(), rings


def ring_is_hole(ring):
    """Shapefile convention: outer rings clockwise, holes counter-clockwise."""
    x, y = ring[:, 0], ring[:, 1]
    return (np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) > 0


def rasterize(rings_iter, proj, ppm, shape, value_of, base=0):
    """Rasterise polygons into an int32 array; later shapes overwrite earlier ones.

    rings_iter yields (key, rings); value_of(key) gives the fill value.
    Rings are unwrapped and drawn three times (shifted by one map width) so
    shapes crossing the seam are handled for any centre longitude.
    """
    from PIL import Image, ImageDraw
    h, w = shape
    img = Image.new("I", (w, h), base)
    draw = ImageDraw.Draw(img)
    for key, rings in rings_iter:
        val = value_of(key)
        outer = [r for r in rings if not ring_is_hole(r)]
        holes = [r for r in rings if ring_is_hole(r)]
        for group, fill in ((outer, val), (holes, base)):
            for ring in group:
                lon = np.degrees(np.unwrap(np.radians(proj.rel_lon(ring[:, 0])))) + proj.lon0
                x, y = proj.forward(lon, ring[:, 1], wrap=False)
                for shift in (-proj.width, 0.0, proj.width):
                    xs = (x + shift) * ppm
                    if xs.max() < 0 or xs.min() > w:
                        continue
                    draw.polygon(list(zip(xs.tolist(), (y * ppm).tolist())), fill=fill)
    return np.asarray(img, dtype=np.int32)


def save_json(path, obj):
    Path(path).write_text(json.dumps(obj, indent=1, ensure_ascii=False))


def load_json(path):
    return json.loads(Path(path).read_text())
