## Credits

Made with [Natural Earth](https://www.naturalearthdata.com/). Free vector and raster map data @ naturalearthdata.com.

# Making the sea board

Everything is done in the web tool (`webtool/`): generating tiles, editing them by hand and exporting the board.
The tile generator is in `src/`, the default settings in `src/config.yaml`. These paths are from the repo root.

## Setup (once)

Linux only. Needs [uv](https://docs.astral.sh/uv/), Python 3.12+, the Cairo library, fontconfig and the DejaVu fonts
(Debian/Ubuntu: `apt install libcairo2 fontconfig fonts-dejavu-core`). Start in the repo root:

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r webtool/requirements.txt
```

## Start

```bash
webtool/run.sh                 # http://127.0.0.1:8765
webtool/run.sh --host 0.0.0.0  # reachable from other machines
```

At the first start the tool downloads the Natural Earth map data by itself (about 90 MB, about 170 MB on disk,
into `data/natural_earth`). Generate makes new tiles and the atlas map (one to two minutes); Export writes
`board.pdf`, `board.svg`, a preview and `tiles.json`. See `webtool/README.md`.

## Main settings

All of them are in the menubar of the tool. A changed setting is kept in `webtool/state/config.yaml`; *Reset to
defaults* drops the change.

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
| `passages` | canals and straits: end points `a`, `b`, optional `via` route, `enabled`. Skipped if an end is not in a tile or both are in the same one. A new design starts with these; after that they are edited per design |
| `board.*`, `map.*` | board size, projection, centre longitude, latitude range |
| `compose.map_art` | draw the atlas map (`true`, default) or a plain blue sea (`false`) |
| `compose.language` | `en` or `nl` |
| `day_track.*` | size and colours of the day track |
