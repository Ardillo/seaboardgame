## Credits

Made with [Natural Earth](https://www.naturalearthdata.com/). Free vector and raster map data @ naturalearthdata.com.

# Generating the sea board

Code is in `src/`, settings in `src/config.yaml`, output in `out/`. These paths are from the repo root.

## Setup (once)


### Linux
Needs [uv](https://docs.astral.sh/uv/), Python 3.12+, the Cairo library, fontconfig and the DejaVu fonts
(Debian/Ubuntu: `apt install libcairo2 fontconfig fonts-dejavu-core`). Start in the repo root:

```bash
uv venv --python 3.12 --system-site-packages .venv
uv pip install --python .venv/bin/python -r webtool/requirements.txt
cd src
PY=../.venv/bin/python
$PY fetch_data.py       # Natural Earth: ~90 MB download, ~170 MB on disk
```

All commands below run from `src/`. In a new shell, repeat `cd src` and the `PY=` line.
`fetch_data.py` skips folders that exist; after a broken download, delete that folder and run it again.

## Build the board

```bash
$PY make_tiles.py       # 1. tiles, sea names, passages (about 1–2 min, longer for a bigger board)
$PY make_art.py guide   # 2. atlas map image (seconds)
$PY compose_board.py    # 3. board (about 30 s)
```

| Output in `out/` | What |
|---|---|
| `board/board.pdf`, `board/board.svg` | the board |
| `board/board.png` | 300 dpi; skipped, so left as it was, with `compose_board.py --no-png` |
| `board/board_preview.jpg` | small preview |
| `tiles/report.txt` | seas left out or merged, refine rounds, sizes, passages, warnings |
| `tiles/preview.png` | colour check of the tile layout |
| `tiles/tiles.json` | tiles (numbered from 1), neighbours, seas, passages, edge crossings |
| `tiles/borders.json`, `tiles/labels.npy` | border lines; tile number per pixel (0 = no tile) |
| `art/guide.png` | the atlas map |

## What to rerun after a change

| Changed in `config.yaml` | Run steps |
|---|---|
| `board.*`, `map.*` | 1, 2, 3 |
| `tiles.*`, `seas.*`, `passages` | 1, 3 |
| `compose.language`, `compose.font`, `compose.ocean_label_mm`, `compose.sea_label_mm` | 1, 3 (names are placed in step 1) |
| other `compose.*`, `day_track.*` | 3 |
| `art.dpi` | 2, 3 |

## Try a variant

`--set key=value` overrides a setting for one run. Give all three steps the same values.
A separate `output_dir` leaves the main board untouched. Relative paths in it start at `src/`.

More tiles:

```bash
O=../out/count100
$PY make_tiles.py --set output_dir=$O --set tiles.count=100
$PY make_art.py guide --set output_dir=$O
$PY compose_board.py --set output_dir=$O
```

Bigger board:

```bash
O=../out/80x53
$PY make_tiles.py --set output_dir=$O --set board.width_mm=800 --set board.height_mm=530
$PY make_art.py guide --set output_dir=$O --set board.width_mm=800 --set board.height_mm=530
$PY compose_board.py --set output_dir=$O --set board.width_mm=800 --set board.height_mm=530
```

Dutch board:

```bash
O=../out/nl
$PY make_tiles.py --set output_dir=$O --set compose.language=nl
$PY make_art.py guide --set output_dir=$O
$PY compose_board.py --set output_dir=$O --set compose.language=nl
```

`--set` cannot edit one entry of `passages`; edit the file for that. It does not report a misspelled last key.
`--config FILE` uses another config file.

## Main settings

| Setting | What it does |
|---|---|
| `tiles.count` | starting number of tiles; refine rounds add or remove some (80 gives 107 now) |
| `tiles.pawn_diameter_mm` | a sea without room for this pawn gets no tile of its own |
| `tiles.open_sea_contact` | decides if such a sea joins its neighbours (open sea) or is left out (inlet, closed off) |
| `tiles.max_width_factor` | widest tile allowed compared with an average tile; applied by the refine rounds |
| `tiles.refine_rounds` | rounds of fixing tiles that are too wide or too narrow |
| `tiles.min_wrap_edge_mm` | shared edge needed to cross the left/right board edge |
| `tiles.random_seed` | another layout with the same rules |
| `tiles.border_noise`, `tiles.sea_border_wiggle_mm` | how organic tile and sea borders are |
| `seas.biggest` | number of biggest seas, gulfs and bays that are used next to the oceans |
| `seas.include_names`, `seas.exclude_names` | seas always or never used; the pawn rule still applies |
| `seas.names_nl` | Dutch names that replace those of Natural Earth, by English name |
| `passages` | canals and straits: end points `a`, `b`, optional `via` route, `enabled`. Skipped if an end is not in a tile or both are in the same one |
| `board.*`, `map.*` | board size, projection, centre longitude, latitude range |
| `compose.map_art` | `guide` = atlas map (default), `art` = SDXL painting |
| `compose.language` | `en` or `nl` |
| `day_track.*` | size and colours of the day track |

## Optional: SDXL painting

Not used for the current board. Needs an NVIDIA GPU (tested with 6 GB) and `torch`, `diffusers`, `transformers`,
`accelerate` and `safetensors` (see the comments in `webtool/requirements.txt`).
The model (~7 GB) downloads on first use. Run step 2 first whenever the board or map settings changed.

```bash
$PY make_art.py samples                  # 3 crops at strengths 0.3/0.4/0.5, about 3 min
$PY make_art.py full                     # whole map at art.strength, about 4 min
$PY compose_board.py --art art           # board with the painting
```

Samples are in `out/art/samples/`. Each sheet shows the guide, then increasing strength.
Other strengths: `$PY make_art.py samples --strengths 0.35,0.45`.

## Editing by hand

`webtool/run.sh` starts the browser editor on http://127.0.0.1:8765, see `webtool/README.md`.
