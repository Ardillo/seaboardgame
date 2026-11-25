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
| Map art | **Atlas map** (Natural Earth II: realistic colours and relief), chosen 2026-11-22 to keep things simple. `compose.map_art` switches it on or off. The SDXL painting was removed in PR 4 (see Restructuring) |
| Webtool only (2026-11-22) | The project becomes a web application only: no separate command-line workflow. SDXL is removed, git keeps designs and settings only (the first start makes everything else ready), Windows is not supported. Plan in the section Restructuring below |
| Day track | My proposal, open to change: 7 squares in the bottom panel; Mon–Fri blue, a gap, then Sat–Sun orange. Abbreviation plus full day name, English or Dutch (`compose.language`). In the webtool each day and the legend can be edited |
| Names | English or Dutch from Natural Earth. The Dutch North/South Atlantic and Pacific names are set in `seas.names_nl`, because Natural Earth drops north and south there |
| Publishing (2026-11-22) | GitHub repo. All rights reserved, ardillo (`LICENSE`); credit to Natural Earth in `README.md`. Downloaded and generated files are not committed; paths are relative to `src/` |

## How it is built (one web tool)

1. **Geometry**, `src/make_tiles.py` (run by Generate as a separate process, so Cancel can stop it)
   - Natural Earth land and marine areas (public domain) are drawn into a pixel grid (4 px/mm).
   - Sea regions come from Natural Earth's named seas. Gaps are filled by distance through the water, so a fill only crosses land at the listed straits.
   - The straight lines of the ocean boundaries are bent with a noise field.
   - Sea pieces where no pawn fits: open sea joins its neighbours, inlets and closed-off seas are left out.
   - Tiles are grown inside each sea with a geodesic Voronoi, then relaxed with Lloyd relaxation plus area balancing. Borders get a slight wiggle.
   - Refine rounds: one tile fewer where a tile is too narrow for the pawn, extra tiles where tiles are too wide.
   - Sea names are placed by searching for a free spot inside their own sea, clear of the pawn spots (where the tile numbers are), other names and edge arrows.
   - Output, in the run folder: `tiles.json` (tiles, seas, neighbours, passages, edge crossings, pawn spots), `borders.json`, `labels.npy` (tile per pixel), `preview.png`, `report.txt`. Generate turns it into a design.
2. **Map image**, `src/map_image.py`: Natural Earth II (realistic colours with relief) reprojected to the board, at
   `art.dpi`. Made by Generate, or again with Generate › *Rebuild map image*.
3. **Editor**, `webtool/`: edits tiles, names, passages, fields and the day track by hand in the browser
   (`webtool/README.md`).
4. **Export**, `webtool/compose.py` (the only composer): the map image, tile colours, borders, tile numbers, sea
   names, passages, edge arrows, frame and fields as an SVG; the server writes `board.svg`, `board.pdf`, a preview, an
   optional print PNG and `tiles.json`.

Settings: the defaults are `src/config.yaml`; what you change in the tool is kept in `webtool/state/config.yaml`.

## Restructuring: webtool only (planned 2026-11-22; PRs 1–4 done)

The project began as command-line scripts (`src/`) with the webtool (`webtool/`) added later. It becomes one web
application. "How it is built" above describes the code after PR 4; PR 5 moves the files to the target layout.

### Decisions

| Topic | Decision |
|---|---|
| Workflow | Only the web application. No command-line steps, no `out/` folder, no "Import main project's board" |
| SDXL | Removed completely: code, settings, menu items and files (list under Findings) |
| Git | Designs and settings only. Downloaded data, map images, exports and runs are not committed |
| First start | `run.sh` and the tool make everything ready by themselves: Python packages, system check, map data, map images |
| Platform | Linux only; Windows support is dropped |
| Target machine | One CPU core, so the speed-up must not rely on parallel work |
| Relaxation steps | `tiles.lloyd_iterations` stays at 40 (decided 2026-11-22): the faster code must give exactly the same board |

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
| 1. Safety ✓ | Reference tests (`webtool/tests/reference.py`) and a server safety test (`webtool/tests/server_safety.py`); the three server bugs fixed | tests pass; the three bugs cannot be reproduced |
| 2. Speed ✓ | Single-core rewrite of the tile search (Findings; the prototype, its diff and checks are in `PR_2_speed_prototype.md`) | byte-identical board on the reference settings; your board in about 100 s or less on the target machine (71 s here on one core; still to be timed on the target machine) |
| 3. First start ✓ | Check the map data at start and download what is missing in the background, with progress and Retry. A folder only counts when it is complete. Editing and export keep working meanwhile; Generate and the map image wait | works from an empty, a half-downloaded and an offline start |
| 4. One app, no SDXL ✓ | One composer and one settings source instead of the pipeline scripts plus the webtool. SDXL removed. "Reset to main" becomes "Reset to defaults" | export identical to today's for the same design |
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
- **PR 2 done (2026-11-25).** The prototype is built into `src/make_tiles.py`, with the clean-ups from
  `PR_2_speed_prototype.md`: `heapq` removed; the "every tile one piece" pass works on a box per tile that grows
  exactly when the tile takes over a fragment (no whole-map compare per tile, no skipped tiles). Results, pinned
  to one core on this machine:
  - the real board (`tests/reference.py --full`): tiles in **71 s** (was 318 s), byte-identical;
  - `tests/reference.py` now has 10 cases: `quick`, `no-wiggle` and the other eight settings of the prototype
    comparison (projection, resolution, pawn 8 and 16 mm, 50/100/150 tiles, seeds, centre longitude, wiggle 0
    and 0.9). The new references were made with the old code from `main`; all 10 match. The run takes 3 min
    (the old code took 7 min for the same cases);
  - `tests/server_safety.py`: all safe, on the real board in `out/`.
  - Still open: time Generate on the target machine (aim: about 100 s or less).
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
- **PR 3 done (2026-11-25).** The download lives in `src/fetch_data.py` (used by the tool and by the command line):
  - At start the server checks the data and downloads what is missing in the background. A "Map data" pill at
    the top shows the progress; after a failure it says "Retry" and a click tries again.
  - A folder only counts when it is complete. A download goes to `.download/` first and becomes the real folder
    only when it is whole; it is then marked with a `.complete` file. A folder without that mark (yours, from
    before) is checked file by file: `.shp`, `.shx`, `.dbf` and the `.tif` against the length their own header
    gives. Your folders pass and are marked on the first start; an empty or cut-off folder is downloaded again.
  - An interrupted download continues where it stopped (HTTP Range; the Natural Earth server supports it).
  - Generate, Import and the map image wait for the data inside their job (with progress in the log; Cancel
    works); when the download fails they stop with "could not be downloaded … press Retry". Editing and export
    never wait.
  - `tests/first_start.py` (21 checks, 1 minute) covers the empty, half-downloaded and offline starts with a local
    stand-in for Natural Earth. Also checked by hand: a real download from Natural Earth gives files identical to
    yours, and a real resume after 30 MB. `server_safety.py` and `reference.py` still pass.
  - Checked in a browser (headless Chromium, with a slow stand-in download): the pill counts up
    ("Map data · 43 % · part 1 of 4"), turns red with "Map data missing · Retry" and a message when the connection
    drops, and disappears after Retry once the data is complete. The design stays open and usable throughout;
    no errors in the browser console.

**Server bugs (fixed in PR 1)**
1. The samples route served any file the server could read, without a login. Now it only serves sample sheets
   from the design's own run folder under `work/runs/`.
2. Importing or generating under an existing design name overwrote that design without asking. Now the server
   refuses (409) unless the page asks for a replace, and the page asks first. Saving cannot create a design.
3. `..`, `.` and names starting with a dot were accepted as design names and pointed outside `designs/`.
   Now a name has to start with a letter or digit.

4. Found after PR 1 (fixed in a small follow-up PR): Cancel pressed in the first moment of a job, before the
   generator had started, was ignored, so the job ran on for the whole generation (about 5 minutes). Now Cancel
   stops a job within a second at any moment.

`webtool/tests/server_safety.py` checks all of this (39 checks, including no saving into a design while a job
replaces it and both Cancel cases). The code from before PR 1 fails the checks for all three bugs; the code from
before the Cancel fix fails "Cancel right after Generate". Every wait in the test has a time limit, so a broken
server makes it fail, not hang.

**SDXL: everything that goes** (all removed in PR 4, except the files on disk)
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

**PR 4 done (2026-11-25): one app, no SDXL**
- One composer: `webtool/compose.py` draws the whole board in the server process. `src/compose_board.py` is gone,
  and so is the old way of exporting (run `compose_board.py` on a stripped `tiles.json`, then cut its SVG apart to
  add tile colours, own arrows, frame and fields).
- One settings source: `src/config.yaml` holds the defaults (now also the frame settings, which were in
  `server.py`), `webtool/state/config.yaml` only what you changed. "Reset to main" is "Reset to defaults" in every
  section; Inspect › *Use default route* and the passages reset take the default passages.
- No main project: Import, `out/` and the command-line steps are gone; a design comes from Generate (or a copy).
- SDXL removed: `src/make_art.py` is replaced by `src/map_image.py` (atlas map only, made inside Generate and by
  Generate › *Rebuild map image*; it runs inside the server, so Cancel during those few seconds stops the job right
  after them). `compose.map_art` is on/off. Older settings files are upgraded when read:
  `guide`/`art` becomes on, `none` off, and the SDXL keys are dropped.
- `requirements.txt` without SDXL and `scikit-image`; the venv no longer needs `--system-site-packages`: in a fresh
  venv made only from `requirements.txt` (no torch), `tests/reference.py` gives the same board.
- Checks:
  - Export identical: the committed `main` design exported with the old and the new code in five variants (as it
    is; tile colours, pawn circles, bigger red arrows, a moved and a hidden arrow, an extra field; every layer off
    and no map image; Dutch with another font and colour; a generated board with a frame). `board.svg`,
    `tiles.json`, `borders.json` and the preview are byte-identical in all five. An export took about 13 s here
    instead of 21 s (no separate process).
  - `tests/reference.py`: all fingerprints unchanged except `design.json`, whose stored settings lost the SDXL keys
    and `output_dir`, have `map_art: true` and the frame defaults (checked field by field), and the pipeline's own
    `board.svg`, which no longer exists. `tests/parity.py` (pipeline against tool) is gone with the pipeline.
  - `tests/server_safety.py` (38 checks) now generates small boards instead of importing; `tests/first_start.py`
    uses Generate where it used Import. Both pass.
  - In a browser (headless Chromium): menus without Import and SDXL, Map image on/off in the editor, the Compose
    panel with a checkbox and "Reset to defaults", Rebuild map image, Export, and the empty start; no console errors.

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
- [ ] Restructuring to webtool only: PRs 1–6 above (PRs 1–4 done)
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
