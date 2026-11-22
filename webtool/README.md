# Sea Board Designer (web tool)

A browser editor to iterate on the board of the co-op sea game. It drives the
main pipeline in `../src` **without changing it**: the scripts are run as-is
with the tool's own copy of the config, and all output stays in this folder. All paths are relative to `server.py`
(`../src`, `../out`, `../.venv`); override with `BOARD_SRC`, `BOARD_MAIN_OUT`, `BOARD_PY`.

```bash
./run.sh                 # http://127.0.0.1:8765
./run.sh --host 0.0.0.0  # reachable from other machines
```

## What you can do

| Where | What |
|---|---|
| Menubar, right half | Every `config.yaml` section (Board, Map, Tiles, Seas, Passages, Art, Compose, Day track) plus **Frame**. Badges: *live* (applies at once), *regenerate* (needs new tiles), *art*. A blue dot marks values that differ from the main project; "Reset to main" copies its values back. |
| File / Generate | Import the main project's current board (seconds), or generate new tiles from the menubar settings (runs `make_tiles.py`, a few minutes). Art: guide map, SDXL samples, full SDXL run. Export: `board.pdf`, `board.svg`, preview and `tiles.json` (neighbours, passages, fields) via `compose_board.py`. |
| Tools (left) | **Select** (V) · **Move tile** (M: drag a tile to a new centre, neighbours regrow) · **Add/split** (A: click in a tile to split it, click empty water to grow a new tile) · **Merge** (G) · **Brush** (B: drag from inside a tile to grow it) · **Eraser** (E) · **Fields** (F: free spaces on the board for game uses not yet known) · **Link** (L: extra passage between two tiles) · **Pan** (H / Space / middle mouse) |
| Sidebar | Inspect (tile, field, passage), Seas (rename, colour, class, label), Fields (edge-track generator: top, bottom, left, right, all around, bottom panel), Report (pawn fit, fragments, unreachable tiles, size outliers, passages), Log (job output). |

Undo/redo covers every edit (Ctrl+Z / Ctrl+Y). Designs autosave every minute (File menu).

To keep fields off the map, set a **Frame** (menubar) and generate new tiles: the map
shrinks to leave a border, and the export draws the frame and fields around the map.

## Files

```
server.py            stdlib HTTP server + jobs (generate, import, art, export)
static/              index.html, style.css, js/{app,design,raster,render,projection}.js
state/config.yaml    the tool's copy of ../src/config.yaml (new keys from the main config are merged in)
designs/<name>/      design.json (tiles, seas, passages, fields), labels.bin (int16 tile id per pixel,
                     4 px/mm), water.bin, art; export/ holds the composed board
work/runs/<id>/      output_dir of a generator run
```

Coordinates: tiles, pawn spots, sea names and passages are in mm on the map area
(same as the pipeline's `tiles.json`); fields are in mm on the whole board.
