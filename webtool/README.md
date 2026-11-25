# Sea Board Designer (web tool)

A browser tool to make the board of the co-op sea game: it generates tiles (with `../src/make_tiles.py`), lets you
edit them by hand and exports the board. Settings are the defaults in `../src/config.yaml` plus what you change in
the menubar (kept in `state/config.yaml`). All paths are relative to `server.py` (`../src`, `../.venv`); override
with `BOARD_SRC`, `BOARD_PY`.

```bash
./run.sh                 # http://127.0.0.1:8765
./run.sh --host 0.0.0.0  # reachable from other machines
```

At start the tool checks the Natural Earth map data (`../data/natural_earth`) and downloads what is missing in the
background (about 90 MB). A "Map data" pill at the top shows the progress; click it to retry when the download
failed (for example offline). Editing and export work meanwhile; Generate and the map image wait for it.
A folder only counts when it is complete; an interrupted download continues where it stopped.

## What you can do

| Where | What |
|---|---|
| Menubar, right half | The settings sections plus **Frame**. Badges: *live* (editor and export, at once), *next edit*, *on reset*, *regenerate* (needs new tiles), *art* (the map image). A blue dot marks values changed here; every other value follows the defaults. "Reset to defaults" drops the changes of a section. **Passages** are stored per design. |
| File / Generate | Generate new tiles from the menubar settings (one to two minutes) into a new design, with the atlas map. *Rebuild map image* makes the map image of the open design again (after a change of `art.dpi`). Export: `board.pdf`, `board.svg`, preview and `tiles.json` (neighbours, passages, fields), composed by `compose.py`. |
| Tools (left) | **Select** (V) · **Move tile** (M: drag a tile to a new centre, neighbours regrow) · **Add/split** (A: click in a tile to split it, click empty water to grow a new tile) · **Merge** (G) · **Brush** (B: drag from inside a tile to grow it) · **Eraser** (E) · **Fields** (F: free spaces on the board for game uses not yet known) · **Link** (L: extra passage between two tiles) · **Pan** (H / Space / middle mouse) |
| Sidebar | Inspect (tile, field, passage), Seas (rename, colour, class, label), Fields (edge-track generator: top, bottom, left, right, all around, bottom panel), Report (pawn fit, fragments, unreachable tiles, size outliers, passages), Log (job output). |

The seven **day squares** and the **legend** are fields: click to edit, drag to move, Del to delete.
Show or hide them under View or in the Fields tab (export follows this); *Reset day track* and
*Reset legend* bring the defaults back. The Day track menu holds the defaults used by that reset,
and a day follows the board language until you rename it. Designs from before this change get
these fields when opened. The empty strip below the map is board height the map does not need.

**What you see is what is exported.** Everything under View › *On the board* and *Tile colour*
(with opacity), and every *live* setting, applies to the editor and the export. Map image, tile numbers and
sea names are the same switches as in Compose, for all designs; the other View items are stored per design.
Only the editing aids (problems, water without a tile, selection) stay on screen.

**Passages** can bend: click one, then drag its line to add a waypoint, drag a point to move it,
Alt+click a point to remove it. Inspect › *Use default route* restores one.

**Edge arrows** (around the world): drag one, or select it and use the up/down keys; it stays on the edge its
two tiles share and both sides move together. Inspect has *Hide arrow only* (still connects), *Close crossing*
(no connection) and *Back to automatic*; hidden and closed ones are listed under Report › Crossings.
Size and colour of all arrows are under View › Arrows. All of this is saved per design and exported.
Untouched arrows keep the generator's positions (with another size they shift only if needed to stay on the map).

Undo/redo covers every edit (Ctrl+Z / Ctrl+Y). Designs autosave every minute (File menu).

To keep fields off the map, set a **Frame** (menubar) and generate new tiles: the map
shrinks to leave a border, and the export draws the frame and fields around the map.

## Tests

Run from this folder:

```bash
../.venv/bin/python tests/reference.py         # same board as the saved references, 10 cases (about 3 min)
../.venv/bin/python tests/reference.py --full  # also the real board settings (minutes more)
../.venv/bin/python tests/server_safety.py     # no reading or overwriting what a request should not; Cancel works (1 min)
../.venv/bin/python tests/first_start.py       # map data download: empty, half-downloaded and offline start (1 min)
```

`tests/reference.py` runs the tile generator, the map image, a new design and its export on fixed settings
(`tests/reference_config.yaml`) and compares fingerprints of every output with `tests/reference.json`. Only after a
change that should change the board, save new ones with `--update`. The fingerprints depend on the package versions
in `requirements.txt`. `tests/server_safety.py` generates small boards and copies `designs/main` into a temporary
folder; both tests need the Natural Earth data (`--data` to point elsewhere) and leave designs and settings alone.
`tests/first_start.py` downloads from a small local stand-in for Natural Earth (never the internet) into temporary
folders.

Generating into the name of an existing design asks before replacing it.

## Files

```
server.py            stdlib HTTP server + jobs (generate, map image, export)
compose.py           the board as SVG (the only composer; the editor draws the same layers in render.js)
static/              index.html, style.css, js/{app,design,raster,render,projection}.js
state/config.yaml    only the settings changed here; the others follow the defaults (../src/config.yaml)
designs/<name>/      design.json (tiles, seas, passages, fields), labels.bin (int16 tile id per pixel,
                     4 px/mm), water.bin, art.png (map image); export/ holds the composed board
work/runs/<id>/      output_dir of a generator run
```

Coordinates: tiles, pawn spots, sea names and passages are in mm on the map area
(same as the generator's `tiles.json`); fields are in mm on the whole board.
