#!/usr/bin/env bash
# Start the Sea Board Designer. Extra args go to server.py (e.g. --host 0.0.0.0 --port 9000).
# Uses ../.venv if it exists, else python3 from PATH.
cd "$(dirname "$0")" || exit 1
PY=../.venv/bin/python
[ -x "$PY" ] || PY=python3
PYTHONDONTWRITEBYTECODE=1 exec "$PY" server.py "$@"
