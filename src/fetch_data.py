"""Download the Natural Earth data the board is built from (public domain).

Only complete folders count. A download goes to a temporary place first and only becomes the real folder when
it is complete; a folder is then marked with a `.complete` file. A folder without that mark (from an older
version, or copied by hand) is checked file by file and marked when it is whole; otherwise it is downloaded again.
An interrupted download continues where it stopped when the server allows it.
"""
import os
import shutil
import struct
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

BASE = "https://naciscdn.org/naturalearth"
# name: (url, files the folder must have; .shp/.shx/.dbf/.tif are also checked for their full length)
DATASETS = {
    "ne_50m_land": (f"{BASE}/50m/physical/ne_50m_land.zip",
                    ["ne_50m_land.shp", "ne_50m_land.shx", "ne_50m_land.dbf"]),
    "ne_50m_antarctic_ice_shelves_polys": (f"{BASE}/50m/physical/ne_50m_antarctic_ice_shelves_polys.zip",
                                           ["ne_50m_antarctic_ice_shelves_polys.shp",
                                            "ne_50m_antarctic_ice_shelves_polys.shx",
                                            "ne_50m_antarctic_ice_shelves_polys.dbf"]),
    "ne_10m_geography_marine_polys": (f"{BASE}/10m/physical/ne_10m_geography_marine_polys.zip",
                                      ["ne_10m_geography_marine_polys.shp", "ne_10m_geography_marine_polys.shx",
                                       "ne_10m_geography_marine_polys.dbf"]),
    "NE2_50M_SR_W": (f"{BASE}/50m/raster/NE2_50M_SR_W.zip", ["NE2_50M_SR_W/NE2_50M_SR_W.tif"]),
}
TILES = ["ne_50m_land", "ne_50m_antarctic_ice_shelves_polys", "ne_10m_geography_marine_polys"]   # tiles, import
MAP_IMAGE = ["NE2_50M_SR_W"]                                                                     # atlas map
MARK = ".complete"
CHUNK = 1 << 16


class Cancelled(Exception):
    pass


def file_whole(path):
    """Is this file there and as long as its own header says?"""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            head = f.read(32)
            ext = path.suffix.lower()
            if ext in (".shp", ".shx"):         # file length in 16-bit words, big-endian, at byte 24
                return len(head) >= 28 and struct.unpack(">i", head[24:28])[0] * 2 == size
            if ext == ".dbf":                   # records × record length after the header
                if len(head) < 12:
                    return False
                n, hlen, rlen = struct.unpack("<IHH", head[4:12])
                return size >= hlen + n * rlen
            if ext == ".tif":
                return tif_whole(path, size)
        return size > 0
    except OSError:
        return False


def tif_whole(path, size):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    try:
        with Image.open(path) as im:
            offsets, counts = im.tag_v2.get(273), im.tag_v2.get(279)        # strip offsets and byte counts
            if not offsets or not counts:
                return False
            return max(o + c for o, c in zip(offsets, counts)) <= size
    except Exception:       # noqa: BLE001 - any broken image is "not whole"
        return False


def folder_ok(data, name, mark=True):
    """Complete? A folder without the mark is checked and (with `mark`) marked when whole."""
    folder = Path(data) / name
    if (folder / MARK).is_file():
        return True
    if not folder.is_dir() or not all(file_whole(folder / f) for f in DATASETS[name][1]):
        return False
    if not mark:
        return True
    try:
        (folder / MARK).write_text("checked\n")
    except OSError:
        pass
    return True


def missing(data, names=None, mark=True):
    return [n for n in (names or DATASETS) if not folder_ok(data, n, mark)]


def download(data, name, progress=None, cancelled=None):
    """Fetch one data set into data/name. progress(name, done_bytes, total_bytes_or_None)."""
    data = Path(data)
    work = data / ".download"
    work.mkdir(parents=True, exist_ok=True)
    url = DATASETS[name][0]
    part = work / f"{name}.zip.part"
    have = part.stat().st_size if part.exists() else 0
    req = urllib.request.Request(url, headers={"User-Agent": "seaboard-fetch"})
    if have:
        req.add_header("Range", f"bytes={have}-")
    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:
        if e.code != 416:           # 416: nothing left to fetch, or a stale part: start again
            raise
        part.unlink()
        return download(data, name, progress, cancelled)
    with resp:
        if have and resp.status != 206:     # the server sends the whole file again
            have = 0
        length = resp.headers.get("Content-Length")
        total = have + int(length) if length else None
        done = have
        with open(part, "ab" if have else "wb") as f:
            while True:
                if cancelled and cancelled():
                    raise Cancelled()
                chunk = resp.read(CHUNK)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if progress:
                    progress(name, done, total)
    if total is not None and done < total:
        raise OSError(f"{name}: connection closed after {done} of {total} bytes")
    unpack = work / name
    shutil.rmtree(unpack, ignore_errors=True)
    try:
        with zipfile.ZipFile(part) as z:
            z.extractall(unpack)
    except zipfile.BadZipFile:
        part.unlink()
        raise OSError(f"{name}: the download is not a valid zip file; try again")
    if not all(file_whole(unpack / f) for f in DATASETS[name][1]):
        shutil.rmtree(unpack, ignore_errors=True)
        part.unlink()
        raise OSError(f"{name}: the download does not hold the expected files")
    (unpack / MARK).write_text(url + "\n")
    target = data / name
    if target.exists():         # an incomplete older folder
        shutil.rmtree(target)
    os.replace(unpack, target)
    part.unlink()


def fetch_missing(data, names=None, progress=None, cancelled=None, say=print):
    """Download every data set that is not complete. Raises on the first failure."""
    Path(data).mkdir(parents=True, exist_ok=True)
    for name in names or DATASETS:
        if folder_ok(data, name):
            say(f"have  {name}")
            continue
        say(f"fetch {DATASETS[name][0]}")
        download(data, name, progress, cancelled)
    shutil.rmtree(Path(data) / ".download", ignore_errors=True)


def main():
    from board_common import load_config, parse_args
    cfg = load_config(parse_args(__doc__))
    data = Path(cfg["data_dir"])
    shown = {}

    def progress(name, done, total):
        mb = done >> 20
        if shown.get(name) != mb:
            shown[name] = mb
            print(f"  {mb} MB" + (f" of {total >> 20} MB" if total else ""), end="\r", flush=True)
    fetch_missing(data, progress=progress)
    print("done:", data)


if __name__ == "__main__":
    main()
