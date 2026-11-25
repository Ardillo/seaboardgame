#!/usr/bin/env python3
"""First-start test: the map data download from an empty, a half-downloaded and an offline start.

    ../.venv/bin/python tests/first_start.py --out ../out      (about 1 minute)

Nothing is fetched from the internet: a small local web server stands in for Natural Earth. It serves zips made
from your own data folder (the map image is replaced by a small TIFF, to keep it quick) and can be slow, cut a
download off half way, or be away (offline). Every data folder is a temporary one; yours is only read.
Checks:
  - empty start: everything is downloaded, marked complete, the same files as the source
  - empty folders (the old bug: they counted as present) and a cut-off .shp or .tif count as missing
  - a complete folder from before (no mark) is kept and marked, not downloaded again
  - a download cut off half way: the folder does not appear; Retry continues where it stopped (HTTP Range)
  - offline: the state says so; Import fails with a clear message; Retry works once back online
  - Cancel while a job waits for the data stops it at once
  - during a download, saving a design and Export keep working
Needs ../out (the main board; --out) and the Natural Earth data, like Import.
"""
import argparse
import io
import json
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402
import fetch_data  # noqa: E402  (server put ../src on the path)

FAILED = []


def check(what, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + what + (f": {detail}" if detail and not ok else ""), flush=True)
    if not ok:
        FAILED.append(what)


def until(cond, limit):
    end = time.time() + limit
    while not cond() and time.time() < end:
        time.sleep(0.05)
    return cond()


class Host:
    """Stand-in for the Natural Earth server: Range, slow, cut off."""
    def __init__(self, zips):
        self.zips, self.ranges, self.requests = zips, [], []
        self.rate = None        # bytes per second, None = full speed
        self.cut = {}           # name: stop after this many bytes of the file (the connection closes)
        self.abort = False      # close every running download now
        host = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                name = self.path.strip("/").removesuffix(".zip")
                blob = host.zips.get(name)
                host.requests.append(name)
                if blob is None:
                    self.send_error(404)
                    return
                start = 0
                rng = self.headers.get("Range")
                if rng:
                    host.ranges.append((name, rng))
                    start = int(rng.split("=")[1].split("-")[0])
                    if start >= len(blob):
                        self.send_error(416)
                        return
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{len(blob) - 1}/{len(blob)}")
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(len(blob) - start))
                self.end_headers()
                stop = host.cut.pop(name, len(blob))
                pos = start
                try:
                    while pos < stop and not host.abort:
                        n = min(16384, stop - pos)
                        self.wfile.write(blob[pos:pos + n])
                        pos += n
                        if host.rate:
                            time.sleep(n / host.rate)
                except OSError:
                    pass
                self.close_connection = True

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_port

    def use(self, port=None):
        """Point the downloads at this host (or at a port where nothing listens: offline)."""
        p = port or self.port
        for name, (_, files) in list(fetch_data.DATASETS.items()):
            fetch_data.DATASETS[name] = (f"http://127.0.0.1:{p}/{name}.zip", files)


def make_zips(src, tmp):
    """Zips like Natural Earth's, from the folders in src; the map image is a small TIFF."""
    from PIL import Image
    zips = {}
    for name in fetch_data.DATASETS:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            if name == "NE2_50M_SR_W":
                img = io.BytesIO()
                Image.new("RGB", (300, 150), (90, 140, 180)).save(img, "TIFF")
                z.writestr("NE2_50M_SR_W/NE2_50M_SR_W.tif", img.getvalue())
            else:
                for f in sorted((src / name).iterdir()):
                    if f.is_file() and f.name != fetch_data.MARK:
                        z.write(f, f.name)
        zips[name] = buf.getvalue()
    return zips


def run_fetch(d, limit=60):
    """One background check + download for folder d, as the server does it; wait until it ends."""
    until(lambda: not server.DATA.busy(), limit)
    server.DATA.start(d)
    until(lambda: not server.DATA.busy(), limit)
    return server.DATA.as_dict()


def same_files(a, b, name):
    fa = sorted(p.name for p in (a / name).iterdir() if p.name != fetch_data.MARK)
    return fa == sorted(p.name for p in (b / name).iterdir() if p.name != fetch_data.MARK) and \
        all((a / name / f).read_bytes() == (b / name / f).read_bytes() for f in fa)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", help="main board to import (default ../out)")
    ap.add_argument("--data", help="your Natural Earth folder (default: the one the web tool uses)")
    args = ap.parse_args()
    src = Path(args.data).resolve() if args.data else server.data_path(server.my_config())
    if args.out:
        server.MAIN_OUT = Path(args.out).resolve()
    if fetch_data.missing(src, fetch_data.TILES, mark=False):
        sys.exit(f"no complete Natural Earth data in {src}: pass --data")
    if not (server.MAIN_OUT / "tiles/tiles.json").exists():
        sys.exit(f"no main board in {server.MAIN_OUT}: pass --out")
    tmp = Path(tempfile.mkdtemp(prefix="seaboard-first-start-"))
    host = None
    base = f"http://127.0.0.1:{api_port()}/api"      # designs, runs and settings in a temporary folder
    try:
        host = Host(make_zips(src, tmp))
        host.use()
        vector = fetch_data.TILES

        # 1. empty start
        d = tmp / "empty"
        st = run_fetch(d)
        check("empty start: download finishes", st["state"] == "ready", st)
        check("empty start: every folder complete and marked",
              all((d / n / fetch_data.MARK).is_file() for n in fetch_data.DATASETS))
        check("empty start: the same files as the source", all(same_files(d, src, n) for n in vector))
        check("empty start: no download leftovers", not (d / ".download").exists())
        full = d

        # 2. what counts as complete
        d = tmp / "half"
        for n in fetch_data.DATASETS:
            (d / n).mkdir(parents=True)
        check("empty folders count as missing", fetch_data.missing(d) == list(fetch_data.DATASETS))
        shutil.rmtree(d)
        d.mkdir()
        shutil.copytree(src / "ne_50m_antarctic_ice_shelves_polys", d / "ne_50m_antarctic_ice_shelves_polys",
                        ignore=shutil.ignore_patterns(fetch_data.MARK))           # complete, from before: no mark
        shutil.copytree(src / "ne_50m_land", d / "ne_50m_land", ignore=shutil.ignore_patterns(fetch_data.MARK))
        shp = d / "ne_50m_land/ne_50m_land.shp"
        shp.write_bytes(shp.read_bytes()[: shp.stat().st_size // 2])            # cut off half way
        shutil.copytree(full / "NE2_50M_SR_W", d / "NE2_50M_SR_W", ignore=shutil.ignore_patterns(fetch_data.MARK))
        tif = d / "NE2_50M_SR_W/NE2_50M_SR_W/NE2_50M_SR_W.tif"
        tif.write_bytes(tif.read_bytes()[:-500])
        check("a cut-off .shp and .tif count as missing; a whole folder without mark counts as present",
              fetch_data.missing(d) == ["ne_50m_land", "ne_10m_geography_marine_polys", "NE2_50M_SR_W"],
              fetch_data.missing(d))

        # 3. a download cut off half way, then Retry continues it
        host.requests.clear()
        marine = "ne_10m_geography_marine_polys"
        half = len(host.zips[marine]) // 2
        host.cut[marine] = half
        st = run_fetch(d)
        check("cut-off download: error, and the folder does not appear",
              st["state"] == "error" and not (d / marine).exists(), st)
        check("cut-off download: the part is kept", (d / f".download/{marine}.zip.part").stat().st_size == half)
        check("cut-off download: the cut-off .shp folder was downloaded again",
              fetch_data.folder_ok(d, "ne_50m_land") and same_files(d, src, "ne_50m_land"))
        check("the complete folder from before is kept and marked, not downloaded",
              "ne_50m_antarctic_ice_shelves_polys" not in host.requests
              and (d / "ne_50m_antarctic_ice_shelves_polys" / fetch_data.MARK).is_file())
        host.ranges.clear()
        server.data_path = lambda cfg: d        # Retry downloads into the tool's data folder: this one
        code = json.loads(urllib.request.urlopen(urllib.request.Request(
            f"{base}/data/retry", b"{}", method="POST"), timeout=10).read())
        until(lambda: not server.DATA.busy(), 60)
        st = server.DATA.as_dict()
        check("Retry: download finishes", code["state"] in ("checking", "downloading", "ready")
              and st["state"] == "ready", st)
        check("Retry continues where it stopped (Range)", host.ranges == [(marine, f"bytes={half}-")], host.ranges)
        check("after Retry: complete and the same files", not fetch_data.missing(d) and same_files(d, src, marine))

        # 4. offline: no server at all
        d = tmp / "offline"
        dead = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
        dead_port = dead.server_port
        dead.server_close()     # nothing listens on this port now
        host.use(dead_port)
        st = run_fetch(d)
        check("offline: the state is error with a reason", st["state"] == "error" and st["error"], st)
        check("offline: no data folders appear", not any((d / n).exists() for n in fetch_data.DATASETS))
        server.data_path = lambda cfg: d
        job = server.job_import_main("x")
        until(lambda: job.status != "running", 30)
        check("offline: Import fails with a clear message",
              job.status == "error" and "could not be downloaded" in (job.error or ""), job.error)
        host.use()
        st = run_fetch(d)
        check("back online: Retry downloads everything", st["state"] == "ready" and not fetch_data.missing(d), st)

        # 5. Cancel while a job waits for the data
        d = tmp / "cancel"
        server.data_path = lambda cfg: d
        host.rate = 20_000
        job = server.job_import_main("y")
        until(lambda: any("waiting for the map data" in x for x in job.log), 10)
        t = time.time()
        server.CURRENT_JOB[0].cancelled = True
        until(lambda: job.status != "running", 5)
        check("Cancel while waiting for the data stops the job at once",
              job.status == "cancelled" and time.time() - t < 2, f"{job.status} after {time.time() - t:.1f} s")

        # 6. editing and export during a download
        host.abort = True       # end the slow download from step 5
        until(lambda: not server.DATA.busy(), 30)
        host.abort = False
        server.data_path = lambda cfg: full
        host.rate = None
        job = server.job_import_main("a")
        until(lambda: job.status != "running", 120)
        check("import with complete data", job.status == "done", job.error)
        d = tmp / "during"
        server.data_path = lambda cfg: d
        host.rate = 20_000      # a few minutes for everything
        server.DATA.start(d)
        until(lambda: server.DATA.state == "downloading", 10)
        t = time.time()
        meta = json.loads(urllib.request.urlopen(f"{base}/designs/a", timeout=10).read())
        meta["notes_first_start_test"] = 1
        urllib.request.urlopen(urllib.request.Request(f"{base}/designs/a", json.dumps(meta).encode(), method="PUT",
                                                      headers={"Content-Type": "application/json"}), timeout=10)
        check("during a download: opening and saving a design work at once", time.time() - t < 3)
        job = server.job_export("a", False)
        until(lambda: job.status != "running", 180)
        check("during a download: Export works", job.status == "done" and server.DATA.state == "downloading",
              f"{job.status} {job.error or ''}, data {server.DATA.state}")
    finally:
        if host:
            host.abort = True   # end a running download
            until(lambda: not server.DATA.busy(), 30)
            host.srv.shutdown()
        if API[0]:
            API[0].shutdown()
            shutil.rmtree(server.STATE.parent, ignore_errors=True)
        shutil.rmtree(tmp, ignore_errors=True)
    if FAILED:
        sys.exit(f"\n{len(FAILED)} check(s) failed")
    print("\nfirst start works")


API = [None]


def api_port():
    """The web tool's own server, on a free port, with designs and runs in a temporary folder."""
    if API[0] is None:
        tmp = Path(tempfile.mkdtemp(prefix="seaboard-first-start-tool-"))
        server.STATE, server.DESIGNS, server.RUNS = tmp / "state", tmp / "designs", tmp / "runs"
        server.MY_CONFIG = server.STATE / "config.yaml"
        for p in (server.STATE, server.DESIGNS, server.RUNS):
            p.mkdir(parents=True)
        server.Handler.log_message = lambda *a: None
        API[0] = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=API[0].serve_forever, daemon=True).start()
    return API[0].server_port


if __name__ == "__main__":
    main()
