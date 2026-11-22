# Plan: sea board for a co-op game

Goal for now: design the **game board**. It shows a world map (continents and seas) where players move a pawn over
sea tiles. The tiles are roughly the same size but follow natural shapes, and a track shows the 7 days of the week
(5 workdays, then the weekend).
Inspiration (mechanics only, nothing copied): Pandemic (a map of linked spaces, a threat that grows) and
Legends of Andor (a numbered region map, time as a resource). Theme, map and art are our own.
Later stage (not decided yet): a physical or digital co-op board game.

## Decisions taken (2026-11-21 and 22)

| Topic | Decision |
|---|---|
| Projection | Miller cylindrical: rectangular, square corners. Centre on the Greenwich meridian (Atlantic, Europe and Africa in the middle; seam in the Pacific at 180°) |
| Map range | 84°N to 80°S. The map fills the full width; the leftover height becomes a bottom panel |
| Wrap-around | Yes: east and west edges connect (sailing around the world). Tiles stop at the seam. Each crossing has an arrow on both edges, labelled with the tile number on the other side; a crossing needs at least 4 mm of shared edge (`tiles.min_wrap_edge_mm`), so no diagonal jumps |
| Tiles | Start value 80 (`tiles.count`); the refine rules add tiles where needed, giving **107** now. Equal in **board area**, not in km². Numbered from 1, west to east in bands |
| Pawn rule (2026-11-22) | Only seas where a pawn fits get their own tiles. Pawn 12 mm (`tiles.pawn_diameter_mm`; 14 mm would also drop the Mediterranean and Sea of Japan). Pawn size confirmed by the user on 2026-11-22. A sea where no pawn fits loses its own name. If it is **open sea** (long shared edge with other seas: Laccadive, Banda, Solomon, Great Australian Bight), it joins its neighbours. If it is an **inlet or closed off** (Red Sea, Persian Gulf, Black Sea, Baltic), it is left out, and a border line marks where the tiles end (`tiles.open_sea_contact`). After tiling, a sea with a tile too narrow for the pawn gets one tile fewer |
| Tile width (2026-11-22) | A tile may be at most 1.6× as wide as an average tile (`tiles.max_width_factor`), so there is no fast lane east–west (this was the Southern Ocean band). Seas with tiles that are too wide get extra tiles |
| Seas | The 7 oceans plus the **25 biggest seas, gulfs and bays** by real area (`seas.biggest`), **plus North Sea, Baltic Sea, Black Sea, Red Sea and Persian Gulf** (`seas.include_names`), as long as a pawn fits (see the pawn rule). Each one gets at least 1 tile; other seas merge into their neighbour. Open: also add the East China Sea and Gulf of Guinea (ranks 27–28)? |
| Canals | Real big canals: Suez, Panama, Kiel. Because the Red Sea is too narrow for a pawn, Suez is one route, **"Suez Canal + Red Sea"** (Mediterranean to Arabian Sea), drawn along the canal and down the middle of the Red Sea (`via` waypoints in the config). Kiel connects nothing while the Baltic is not drawn. White Sea–Baltic (4 m draft, through lakes), Volga–Don (rivers, to the Caspian, which is a lake) and Corinth (6.4 km, inside the Mediterranean) are in the config but switched off |
| Straits | Gibraltar, Bosporus and Dardanelles, the Danish straits, Bab-el-Mandeb and Hormuz are in the config. Only Gibraltar is used now; the others lead to seas that are not drawn and are skipped automatically |
| Board size | 60×40 cm (`board.width_mm` and `board.height_mm`) |
| Map art | **Atlas map** (Natural Earth II: realistic colours and relief), chosen 2026-11-22 to keep things simple (`compose.map_art: guide`). The SDXL painting (`make_art.py`, strength 0.40) is still in the code but unused, and will be removed (see Restructuring) |
| Webtool only (2026-11-22) | The project becomes a web application only: no separate command-line workflow. SDXL is removed, git keeps designs and settings only (the first start makes everything else ready), Windows is not supported. Plan in the section Restructuring below |
| Day track | My proposal, open to change: 7 squares in the bottom panel; Mon–Fri blue, a gap, then Sat–Sun orange. Abbreviation plus full day name, English or Dutch (`compose.language`). In the webtool each day and the legend can be edited |
| Names | English or Dutch from Natural Earth. The Dutch North/South Atlantic and Pacific names are set in `seas.names_nl`, because Natural Earth drops north and south there |
| Publishing (2026-11-22) | GitHub repo. All rights reserved, ardillo (`LICENSE`); credit to Natural Earth in `README.md`. Downloaded and generated files are not committed; paths are relative to `src/` |

## How it is built (three layers, plus an editor)

1. **Geometry**, `src/make_tiles.py`
   - Natural Earth land and marine areas (public domain) are drawn into a pixel grid (4 px/mm).
   - Sea regions come from Natural Earth's named seas. Gaps are filled by distance through the water, so a fill only crosses land at the listed straits.
   - The straight lines of the ocean boundaries are bent with a noise field.
   - Sea pieces where no pawn fits: open sea joins its neighbours, inlets and closed-off seas are left out.
   - Tiles are grown inside each sea with a geodesic Voronoi, then relaxed with Lloyd relaxation plus area balancing. Borders get a slight wiggle.
   - Refine rounds: one tile fewer where a tile is too narrow for the pawn, extra tiles where tiles are too wide.
   - Sea names are placed by searching for a free spot inside their own sea, clear of the pawn spots (where the tile numbers are), other names and edge arrows.
   - Output: `tiles.json` (tiles, seas, neighbours, passages, edge crossings, pawn spots), `borders.json` (smoothed lines), `labels.npy` (tile per pixel), `preview.png`, `report.txt`.
2. **Map image**, `src/make_art.py`
   - `guide`: Natural Earth II (realistic colours with relief) reprojected to the board. This atlas map is the board art.
   - Optional, not used now (`samples`, `full`): SDXL img2img repaints the atlas map in overlapping 1024 px tiles (about 4 min).
3. **Composition**, `src/compose_board.py`
   - Stacks the map image, borders, tile numbers, sea names, passages, wrap arrows and the day track into an SVG.
   - Exports SVG, PDF, a 300 dpi PNG and a preview.
4. **Editor**, `webtool/`
   - Edits tiles, names, passages, fields and the day track by hand in the browser (`webtool/README.md`).

## Restructuring: webtool only (planned 2026-11-22, not started)

The project began as command-line scripts (`src/`) with the webtool (`webtool/`) added later. It becomes one web
application. "How it is built" above describes the code as it is until these PRs are merged.

### Decisions

| Topic | Decision |
|---|---|
| Workflow | Only the web application. No command-line steps, no `out/` folder, no "Import main project's board" |
| SDXL | Removed completely: code, settings, menu items and files (list under Findings) |
| Git | Designs and settings only. Downloaded data, map images, exports and runs are not committed |
| First start | `run.sh` and the tool make everything ready by themselves: Python packages, system check, map data, map images |
| Platform | Linux only; Windows support is dropped |
| Target machine | One CPU core, so the speed-up must not rely on parallel work |
| Relaxation steps | Open: keep `tiles.lloyd_iterations` at 40 (same board as now, recommended) or lower it to 20 (see Findings) |

### Target layout

All code stays in `src/`.

```
run.sh  requirements.txt  README.md  PLAN.md  LICENSE
src/
  server.py              HTTP only
  defaults.yaml          the default settings (was src/config.yaml)
  seaboard/
    settings.py          defaults plus the user's changes
    data.py              check and download the map data
    designs.py           load, save, upgrade old designs
    jobs.py              background jobs with progress and cancel
    export.py            the only composer (SVG, PDF, PNG, tiles.json)
    generate/            projection, tiles, atlas map image
  web/                   the browser app (was webtool/static)
  tests/
workspace/
  designs/               in git
  settings.yaml          the user's changes, in git
  exports/  runs/        not in git
data/                    downloaded map data, not in git
```

### PRs, in this order

| PR | What | Done when |
|---|---|---|
| 1. Safety | Save the current outputs as reference tests. Fix the three server bugs (Findings) | tests pass; the three bugs cannot be reproduced |
| 2. Speed | Single-core rewrite of the tile search (Findings) | byte-identical board on the reference settings; your board in about 100 s or less on the target machine |
| 3. First start | Check the map data at start and download what is missing in the background, with progress and Retry. A folder only counts when it is complete. Editing and export keep working meanwhile; Generate and the map image wait | works from an empty, a half-downloaded and an offline start |
| 4. One app, no SDXL | One composer and one settings source instead of the pipeline scripts plus the webtool. SDXL removed. "Reset to main" becomes "Reset to defaults" | export identical to today's for the same design |
| 5. Move | New layout; old designs are upgraded when opened | your design opens and exports the same |
| 6. Cleanup | One README, this plan updated, leftovers deleted, Windows TODO removed | a fresh clone gets to an exported board with only `run.sh` and the browser |

Before PR 5: commit the `main` design from the machine where you use the tool (see Findings). From PR 4 on,
no other session should edit `src/` at the same time.

### Findings (2026-11-22)

**Speed of Generate**
- Generate took 342 s here: 336 s for tiles, 5 s for the atlas map, 1 s to build the design. Export takes 26 s.
- 78% of the tile time is one step: a shortest-path search over 3.5 million pixels, run 246 times
  (6 layout rounds × 41 relaxation steps). It uses one core. The same step took 0.59, 1.08 or 2.45 s depending
  on the core it ran on, which explains 400+ s on a slower machine.
- A prototype of the single-core rewrite (bucket queue instead of a heap; each sea searched on its own area;
  a sea with one tile needs no search; small bookkeeping compiled) gave **318 s → 76 s on one core with a
  byte-identical result** on 10 different settings, including no border wiggle (many exact ties). Peak memory
  stays about 750 MB, so the target machine needs about 1 GB free.
- The remaining 76 s is still 70% search (0.22 s per pass). A further exact gain may be possible; not measured.
- Fewer rounds, steps or pixels, measured on 3 seeds (on top of the rewrite, one core):

| Setting | Time | Effect |
|---|--:|---|
| as now (40 steps, 5 rounds, 4 px/mm) | 76 s | reference |
| `lloyd_iterations` 20 | 47 s | 95% of the map in the same tile, about one more over-wide tile |
| `lloyd_iterations` 10 | 33 s | 83–89% the same, tile count shifts |
| `refine_rounds` 3 | 55 s | 3–4 more over-wide tiles on every seed: breaks the tile width rule |
| `raster_px_per_mm` 3 | 43 s | coarser borders, smaller pawn margin |

  Advice: keep the refine rounds and the resolution. Lowering the steps to 20 is acceptable; another seed
  changes the board more (99 to 110 tiles).
- Even now 4–10 tiles per seed are wider than 1.6× an average tile (by this measurement), because refining stops
  after `refine_rounds`.

**First start without data**
- With an empty data folder, Generate and the map image fail with a correct message, but the page never uses the
  server's data check (`data_ok`), so you only find out when a job fails.
- `fetch_data.py` skips every folder that exists, also an empty one. With four empty folders it said "done",
  the server reported the data as present, and Generate then crashed.
- The committed map image of a design is byte-identical to a freshly built one, so it can be rebuilt after the
  download and leave git.

**Server bugs (to fix in PR 1)**
1. The samples route serves any file the server can read, without a login.
2. Importing or generating under an existing design name overwrites that design without asking (import confirmed,
   generate uses the same code).
3. `..` is accepted as a design name and points at the `webtool/` folder.

**SDXL: everything that goes**
- `make_art.py` except the atlas-map step, which moves into Generate.
- Settings under `art:`: `model`, `strength`, `steps`, `guidance`, `tile_px`, `overlap_px`, `seed`, `prompt`,
  `negative_prompt`. Only `art.dpi` (atlas map resolution) stays.
- `compose.map_art: art`: map art becomes on/off.
- In the tool: the SDXL menu items and dialogs, painting files (`painting.png/.jpg`, `has_painting`), reusing the
  main project's painting on Generate, the samples route, the `strength` job option.
- Docs: the SDXL section in `README.md`, the commented SDXL packages in `requirements.txt`.
- On disk, outside git: the 9.3 GB model cache (`~/.cache/huggingface`) and the unused 508 MB `webtool/venv`.
  The venv no longer needs system packages for torch.
- Also unused: `scikit-image` in `requirements.txt` (nothing imports it).

**State of the designs**
- The `main` design in the repo was saved at 02:32 on 2026-11-22 and has no arrow edits; it has 106 tiles because
  tile 108 replaces 45 and 46 and takes part of 59. The design you work on, on another machine, is probably newer:
  commit it before PR 5.
- `webtool/state/config.yaml` is still an old full copy of the config. It only overrides the frame defaults, but it
  is rewritten on the first start.

## Status

- [x] Data download, projection, sea regions, tiles, neighbours, passages, connectivity check
- [x] Fixes from 2026-11-22: pawn rule, narrower Southern Ocean tiles, labelled edge arrows, numbering from 1, names clear of numbers, ice shelves counted as land
- [x] Board composed with the plain guide map (`out/board/board_preview.jpg`)
- [x] SDXL style samples at strengths 0.3, 0.4 and 0.5 (`out/art/samples/*_sheet.jpg`)
- [x] Map art: atlas map (SDXL painting not used for now)
- [x] 2026-11-22: dotted pawn circles removed, Suez drawn over water, open seas without room for a pawn merged (no tile-less patches)
- [x] 2026-11-22: license, credit, relative paths, setup docs tested in a fresh clone, Dutch ocean names
- [x] 2026-11-22: the webtool edits the around-the-world arrows (drag, hide, close, size, colour)
- [ ] Restructuring to webtool only: PRs 1–6 below
- [ ] Print proof: print part of the board at 100% and check the pawn size against the smallest tiles

## Current result (2026-11-22: 107 tiles, 29 seas, 12 mm pawn)

- Tile area: mean 1354 mm² (about 3.7×3.7 cm). Spread 37%, minimum 288 mm², maximum 2620 mm².
- A 12 mm pawn fits in every tile. All tiles are reachable.
- Passages: Suez Canal + Red Sea (Mediterranean to Arabian Sea), Panama Canal, Strait of Gibraltar.

## Open points and known issues

1. **Seas left out by the pawn rule:** Baltic, Black Sea, Red Sea and Persian Gulf. All four are still too narrow on an 80×53 cm board (tested; only the Great Australian Bight regains its own tile there), so they need a much bigger board or a much smaller pawn.
2. **Seas that are not regions** fold into a neighbour and lose their name (e.g. the Java Sea into the South China Sea, the East China Sea into the Sea of Japan).
3. **Sargasso Sea** has no coasts in the data, so its tile is a rounded rectangle in mid-Atlantic. Decide: keep it, bend it, or drop it.
4. **Top edge crossing:** the generator puts the arrows between tiles 1 and 16 1.9 mm from the top edge, so their tips are slightly cut off. In the webtool, drag that arrow down; it then stays on the board.
5. **The Arctic is cut at 84°N**, so a pawn cannot sail over the pole.
6. **Day track:** the design is a first proposal (squares, colours, language, position).
7. **Gameplay** (threat, roles, what the days mean) is not designed yet; this plan only covers the board.
