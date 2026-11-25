"""The map image: Natural Earth II (realistic colours with relief) reprojected to the board (the atlas map)."""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from board_common import Projection

Image.MAX_IMAGE_PIXELS = None
SOURCE = "NE2_50M_SR_W/NE2_50M_SR_W/NE2_50M_SR_W.tif"


def make_map_image(cfg, data_dir, path):
    """Write the atlas map for the board in `cfg` (its map area, at art.dpi) to `path`; returns its size."""
    proj = Projection(cfg)
    img = np.asarray(Image.open(Path(data_dir) / SOURCE).convert("RGB"), np.float32)
    sh, sw = img.shape[:2]
    ppm = cfg["art"]["dpi"] / 25.4
    W, H = int(round(proj.width * ppm)), int(round(proj.map_h * ppm))
    ys, xs = np.mgrid[0:H, 0:W]
    lon, lat = proj.inverse((xs + 0.5) / ppm, (ys + 0.5) / ppm)
    sx = (lon + 180.0) / 360.0 * sw - 0.5
    sy = (90.0 - lat) / 180.0 * sh - 0.5
    out = np.stack([ndimage.map_coordinates(img[..., c], [sy, sx], order=1, mode="grid-wrap")
                    for c in range(3)], -1)
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(path)
    return W, H
