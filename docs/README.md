# Generating the sea board

All code is in `/mnt/src`, all settings in `/mnt/src/config.yaml`, and all output goes to `/mnt/out`.
Run the commands from `/mnt/src` with the project Python:

```bash
cd /mnt/src
PY=/mnt/.venv/bin/python
```

## One-time setup

```bash
cd /mnt && uv venv --system-site-packages .venv
uv pip install --python .venv/bin/python shapely pyshp scipy numba scikit-image cairosvg
cd src && $PY fetch_data.py          # Natural Earth data -> /mnt/data/natural_earth (~90 MB)
```

SDXL (`stabilityai/stable-diffusion-xl-base-1.0`) must be in the Hugging Face cache; it already is on this machine.

## 1. Tiles (about 3-4 minutes)

```bash
$PY make_tiles.py
```

Look at `out/tiles/preview.png` and `out/tiles/report.txt`: seas left out (no room for a pawn), refine rounds, tile sizes and passages.
`tiles.count` is the starting number; the refine rounds can add tiles (too wide) or remove them (too narrow).

## 2. Map art

The board uses the atlas map (`compose.map_art: guide`); only the first command is needed. The SDXL commands are optional.

```bash
$PY make_art.py guide                         # real-colour guide map, seconds
$PY make_art.py samples                       # 3 crops x strengths 0.3/0.4/0.5, about 5 min
$PY make_art.py samples --strengths 0.35,0.45 # try other strengths
$PY make_art.py full                          # whole map, about 15-20 min -> out/art/art.png
```

SDXL only: pick a strength from `out/art/samples/*_sheet.jpg` (left: guide, then increasing strength) and set `art.strength`.

## 3. Board

```bash
$PY compose_board.py                 # map image from compose.map_art (atlas map)
$PY compose_board.py --no-png        # fast check without the big 300 dpi PNG
$PY compose_board.py --art art       # use the SDXL painting instead (after make_art.py full)
```

Output: `out/board/board.pdf`, `board.svg`, `board.png` (300 dpi) and `board_preview.jpg`.

## Changing settings

Edit `config.yaml`, or override a setting for one run with `--set` (works with every script):

```bash
$PY make_tiles.py --set tiles.count=100
$PY make_tiles.py --set tiles.pawn_diameter_mm=14
$PY make_tiles.py --set seas.biggest=15 --set tiles.random_seed=3
$PY make_tiles.py --set board.width_mm=800 --set board.height_mm=530 && $PY compose_board.py --set board.width_mm=800 --set board.height_mm=530
$PY compose_board.py --set compose.language=nl
```

After changing the board size, map range or projection, run all three steps again: tiles, then `make_art.py guide` (and `full`), then compose.

| Setting | What it does |
|---|---|
| `tiles.count` | starting number of sea tiles |
| `tiles.pawn_diameter_mm` | seas where this pawn does not fit lose their own name |
| `tiles.open_sea_contact` | such a sea joins its neighbours (open sea) or is left out (inlet / closed off) |
| `tiles.max_width_factor` | max tile width compared with an average tile (stops fast lanes east-west) |
| `tiles.min_wrap_edge_mm` | minimum shared edge for crossing the left/right edge |
| `tiles.random_seed` | another layout with the same rules |
| `tiles.border_noise`, `tiles.sea_border_wiggle_mm` | how organic the tile and sea borders are |
| `seas.biggest`, `seas.include_names` | which seas get their own tiles |
| `passages` | canals and straits (`enabled: true/false`, optional `via` waypoints for the drawn route) |
| `board.*`, `map.*` | board size, projection, centre longitude, latitude range |
| `art.strength`, `art.prompt` | SDXL look |
| `day_track.*`, `compose.language` | day track size, colours, language |
