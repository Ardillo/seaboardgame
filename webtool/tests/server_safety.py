#!/usr/bin/env python3
"""Server safety test: requests that must not read or overwrite anything they should not.

    ../.venv/bin/python tests/server_safety.py      (about 1 minute)

It starts the server on a free local port with designs, runs and settings in a temporary folder, copies the design
in designs/main into it and tries:
  - reading a file outside the tool through the old samples route (it is gone)
  - design names that point outside designs/ ("..", ".", ".hidden")
  - creating a design by saving to a name that does not exist
  - generating into an existing design without asking (it must be refused; with replace it works)
  - a design whose run_dir points outside work/runs
  - Cancel right after Generate, and Cancel while the generator runs: both must stop the job within seconds
Generate runs on small, coarse settings here (seconds). Needs the Natural Earth data (--data).
Every wait has a time limit: a job that does not end in time fails its check and is stopped, so the test
never hangs and leaves nothing running.
"""
import argparse
import json
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

FAILED = []


def check(what, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + what + (f": {detail}" if detail and not ok else ""))
    if not ok:
        FAILED.append(what)


def finish(job, limit=60):
    """Wait for the job, at most `limit` seconds. A job still running then is stopped (its check fails)."""
    end = time.time() + limit
    while job.status == "running" and time.time() < end:
        time.sleep(0.2)
    if job.status == "running":
        print(f"      (job '{job.title}' still running after {limit} s: stopping it)", flush=True)
        job.cancelled = True
        while job.status == "running" and time.time() < end + 120:
            if job.proc:
                job.proc.terminate()
            time.sleep(0.2)
        return False
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", help="Natural Earth folder (default: the one the web tool uses)")
    args = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="seaboard-safety-"))
    try:
        if args.data:
            data = Path(args.data).resolve()
            server.data_path = lambda cfg: data
        sample = server.WEB / "designs/main"
        if not (sample / "design.json").exists():
            sys.exit(f"no design in {sample}")
        server.STATE, server.DESIGNS, server.RUNS = tmp / "state", tmp / "designs", tmp / "runs"
        server.MY_CONFIG = server.STATE / "config.yaml"
        for p in (server.STATE, server.DESIGNS, server.RUNS):
            p.mkdir(parents=True)
        # quick tiles: a Generate takes seconds
        server.MY_CONFIG.write_text("tiles: {lloyd_iterations: 4, refine_rounds: 1, raster_px_per_mm: 2}\n")
        secret = tmp / "secret.txt"
        secret.write_text("SECRET")
        server.Handler.log_message = lambda *a: None
        srv = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        def call(method, path, body=None):
            data_ = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(f"http://127.0.0.1:{srv.server_port}/api/{path}", data_, method=method)
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status, r.read()
            except urllib.error.HTTPError as e:
                return e.code, e.read()

        def job(req):
            code, body = call("POST", "jobs", req)
            if code == 200:
                finish(server.CURRENT_JOB[0])
            return code, body

        q = lambda s: urllib.parse.quote(s, safe="")        # noqa: E731
        code, _ = job({"kind": "generate", "name": "a", "guide": False})
        check("generate into a new name", code == 200 and server.CURRENT_JOB[0].status == "done")
        design = server.DESIGNS / "a/design.json"
        shutil.copytree(sample, server.DESIGNS / "main", ignore=shutil.ignore_patterns("export"))

        # 1. reading files through the old samples route
        meta = json.loads(design.read_text())
        for run_dir in (str(tmp), "../../..", str(server.RUNS / "r1")):
            meta["run_dir"] = run_dir
            design.write_text(json.dumps(meta))
            for name in (str(secret), "../../secret.txt", "../../../secret.txt", "secret.txt"):
                code, body = call("GET", f"designs/a/samples/{q(name)}")
                check(f"samples: no file via run_dir={run_dir!r}, name={name!r}", b"SECRET" not in body and code >= 400,
                      f"HTTP {code}")
        check("map image jobs never use a run_dir outside work/runs",
              server.RUNS.resolve() in server.design_run_dir({**meta, "run_dir": str(tmp)}).resolve().parents)

        # 2. names that leave designs/
        for bad in ("..", ".", ".hidden"):
            for method, path, body in (("GET", f"designs/{q(bad)}", None), ("GET", f"designs/{q(bad)}/labels", None),
                                       ("PUT", f"designs/{q(bad)}", {"x": 1}), ("POST", "designs/a/copy", {"to": bad})):
                code, _ = call(method, path, body)
                route = "copy to it" if "copy" in path else "labels" if path.endswith("/labels") else "design"
                check(f"name {bad!r}: {method} {route} refused", code == 400,
                      f"HTTP {code}")
            code, _ = job({"kind": "generate", "name": bad})
            check(f"name {bad!r}: generate refused", code == 400, f"HTTP {code}")
        check("nothing written next to designs/", sorted(p.name for p in tmp.iterdir())
              == ["designs", "runs", "secret.txt", "state"], sorted(p.name for p in tmp.iterdir()))

        # 3. saving cannot create a design
        code, _ = call("PUT", "designs/nope", {"_new": True, "name": "nope"})
        check("saving to an unknown design is refused", code == 404 and not (server.DESIGNS / "nope").exists(),
              f"HTTP {code}")

        # 4. replacing an existing design only when asked
        meta = json.loads(design.read_text())
        meta["note"] = "MY EDITS"
        design.write_text(json.dumps(meta))
        before = design.read_text()
        running = server.CURRENT_JOB[0]
        code, body = call("POST", "jobs", {"kind": "generate", "name": "a"})
        check("generate into an existing design is refused before it starts",
              code == 409 and server.CURRENT_JOB[0] is running and design.read_text() == before, f"HTTP {code}")
        if server.CURRENT_JOB[0] is not running:        # it did start (a broken server): stop it
            call("POST", "jobs/cancel")
            finish(server.CURRENT_JOB[0], limit=30)
        stalled = threading.Event()
        real_build = server.build_design
        server.build_design = lambda *a, **k: (stalled.wait(60), real_build(*a, **k))[1]
        code, _ = call("POST", "jobs", {"kind": "generate", "name": "a", "guide": False, "replace": True})
        put_meta, _ = call("PUT", "designs/a", json.loads(before))
        put_labels, _ = call("PUT", "designs/a/labels", {"x": 1})
        stalled.set()
        finish(server.CURRENT_JOB[0])
        server.build_design = real_build
        check("no saving into a design while a job replaces it", code == 200 and put_meta == 409 and put_labels == 409,
              f"HTTP {code}, saves {put_meta} {put_labels}")
        check("with replace it is replaced", server.CURRENT_JOB[0].status == "done"
              and "MY EDITS" not in design.read_text(), server.CURRENT_JOB[0].status)
        code, _ = job({"kind": "generate", "name": "b", "guide": False, "replace": True})
        check("replace on a new name just makes it", code == 200 and (server.DESIGNS / "b/design.json").exists())
        code, _ = job({"kind": "export", "name": "main"})
        check("the copied design exports", code == 200 and server.CURRENT_JOB[0].status == "done"
              and (server.DESIGNS / "main/export/board.pdf").exists(), server.CURRENT_JOB[0].error)

        # 5. Cancel stops a job, also in its first moment (before the generator has started)
        code, _ = call("POST", "jobs", {"kind": "generate", "name": "cancel-at-once"})
        call("POST", "jobs/cancel")
        gen = server.CURRENT_JOB[0]
        t = time.time()
        stopped = code == 200 and finish(gen, limit=20)
        check("Cancel right after Generate stops it", stopped and gen.status == "cancelled",
              f"HTTP {code}, {gen.status} after {time.time() - t:.0f} s")
        code, _ = call("POST", "jobs", {"kind": "generate", "name": "cancel-later"})
        gen = server.CURRENT_JOB[0]
        end = time.time() + 60
        while code == 200 and gen.proc is None and gen.status == "running" and time.time() < end:
            time.sleep(0.1)     # until the generator runs
        proc = gen.proc
        call("POST", "jobs/cancel")
        t = time.time()
        stopped = proc is not None and finish(gen, limit=20)
        check("Cancel while the generator runs stops it", stopped and gen.status == "cancelled"
              and proc.poll() is not None, f"{gen.status} after {time.time() - t:.0f} s")
        srv.shutdown()
    finally:
        cur = server.CURRENT_JOB[0]
        if cur and cur.status == "running":      # never leave a generator running
            finish(cur, limit=0)
        shutil.rmtree(tmp, ignore_errors=True)
    if FAILED:
        sys.exit(f"\n{len(FAILED)} check(s) failed")
    print("\nall safe")


if __name__ == "__main__":
    main()
