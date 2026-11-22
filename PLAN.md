# Plan: sea board for a co-op game

Goal for now: design the **game board**. It shows a world map (continents and seas) where players move a pawn over
sea tiles. The tiles are roughly the same size but follow natural shapes, and a track shows the 7 days of the week
(5 workdays, then the weekend).
Inspiration (mechanics only, nothing copied): Pandemic (a map of linked spaces, a threat that grows) and
Legends of Andor (a numbered region map, time as a resource). Theme, map and art are our own.
Later stage (not decided yet): a physical or digital co-op board game.

## Decisions taken (2026-11-21)

| Topic | Decision |
|---|---|
| Projection | Miller cylindrical: rectangular, square corners. Centre on the Greenwich meridian (Atlantic, Europe and Africa in the middle; seam in the Pacific at 180°) |
| Map range | 84°N to 80°S. The map fills the full width; the leftover height becomes a bottom panel |
| Wrap-around | Yes: east and west edges connect (sailing around the world). Tiles stop at the seam. Each crossing has an arrow on both edges, labelled with the tile number on the other side; a crossing needs at least 4 mm of shared edge (`tiles.min_wrap_edge_mm`), so no diagonal jumps |
| Tiles | Start value 80 (`tiles.count`); the refine rules add tiles where needed, giving **107** now. Equal in **board area**, not in km². Numbered from 1, west to east in bands |
| Pawn rule (2026-11-22) | Only seas where a pawn fits are drawn. Pawn 12 mm (`tiles.pawn_diameter_mm`; 14 mm would also drop the Mediterranean and Sea of Japan). Pawn size confirmed by the user on 2026-11-22. A sea where no pawn fits loses its own name. If it is **open sea** (long shared edge with other seas: Laccadive, Banda, Solomon, Great Australian Bight), it joins its neighbours. If it is an **inlet or closed off** (Red Sea, Persian Gulf, Black Sea, Baltic), it is left out, and a border line marks where the tiles end (`tiles.open_sea_contact`). After tiling, a sea with a tile too narrow for the pawn gets one tile fewer |
| Tile width (2026-11-22) | A tile may be at most 1.6× as wide as an average tile (`tiles.max_width_factor`), so there is no fast lane east–west (this was the Southern Ocean band). Seas with tiles that are too wide get extra tiles |
| Seas | The 7 oceans plus the **25 biggest seas, gulfs and bays** by real area (`seas.biggest`), **plus North Sea, Baltic Sea, Black Sea, Red Sea and Persian Gulf** (`seas.include_names`), as long as a pawn fits (see the pawn rule). Each one gets at least 1 tile; other seas merge into their neighbour. Open: also add the East China Sea and Gulf of Guinea (ranks 27–28)? |
| Canals | Real big canals: Suez, Panama, Kiel. Because the Red Sea is too narrow for a pawn, Suez is one route, **"Suez Canal + Red Sea"** (Mediterranean to Arabian Sea), drawn along the canal and down the middle of the Red Sea (`via` waypoints in the config). Kiel connects nothing while the Baltic is not drawn. White Sea–Baltic (4 m draft, through lakes), Volga–Don (rivers, to the Caspian, which is a lake) and Corinth (6.4 km, inside the Mediterranean) are in the config but switched off |
| Straits | Gibraltar, Bosporus and Dardanelles, the Danish straits, Bab-el-Mandeb and Hormuz are in the config. Only Gibraltar is used now; the others lead to seas that are not drawn and are skipped automatically |
| Board size | 60×40 cm (`board.width_mm` and `board.height_mm`) |
| Map art | **Atlas map** (Natural Earth II: realistic colours and relief), chosen 2026-11-22 to keep things simple (`compose.map_art: guide`). The SDXL painting (`make_art.py`, strength 0.40) stays available as an option but is not used |
| Day track | My proposal, open to change: 7 squares in the bottom panel; Mon–Fri blue, a gap, then Sat–Sun orange. Abbreviation plus full day name, English or Dutch (`compose.language`) |

## How it is built (three layers)

1. **Geometry**, `src/make_tiles.py`
   - Natural Earth land and marine areas (public domain) are drawn into a pixel grid (4 px/mm).
   - Sea regions come from Natural Earth's named seas. Gaps are filled by distance through the water, so a fill never jumps over land.
   - The straight lines of the ocean boundaries are bent with a noise field.
   - Sea pieces where no pawn fits are removed.
   - Tiles are grown inside each sea with a geodesic Voronoi, then relaxed with Lloyd relaxation plus area balancing. Borders get a slight wiggle.
   - Refine rounds: one tile fewer where a tile is too narrow for the pawn, extra tiles where tiles are too wide.
   - Sea names are placed by searching for a free spot inside their own sea, clear of pawn circles, other names and edge arrows.
   - Output: `tiles.json` (tiles, seas, neighbours, passages, pawn spots), `borders.json` (smoothed lines), `preview.png`, `report.txt`.
2. **Art**, `src/make_art.py` (now only the `guide` step is used: the atlas map)
   - Natural Earth II (realistic colours with relief) is reprojected to the board and used as the guide.
   - SDXL img2img repaints it in overlapping 1024 px tiles. A low strength keeps the coastlines in place.
   - No text comes from SDXL.
3. **Composition**, `src/compose_board.py`
   - Stacks art, borders, tile numbers and pawn circles, sea names, passages, wrap arrows and the day track into an SVG.
   - Exports a PDF and a 300 dpi PNG.

## Status

- [x] Data download, projection, sea regions, tiles, neighbours, passages, connectivity check
- [x] Fixes from 2026-11-22: pawn rule, narrower Southern Ocean tiles, labelled edge arrows, numbering from 1, names clear of numbers, ice shelves counted as land
- [x] Board composed with the plain guide map (`out/board/board_preview.jpg`)
- [x] SDXL style samples at strengths 0.3, 0.4 and 0.5 (`out/art/samples/*_sheet.jpg`)
- [x] Map art: atlas map (SDXL painting not used for now)
- [x] 2026-11-22: dotted pawn circles removed, Suez drawn over water, open seas without room for a pawn merged (no tile-less patches)
- [ ] Print proof: print part of the board at 100% and check the pawn size against the smallest tiles

## Current result (2026-11-22: 107 tiles, 29 seas, 12 mm pawn)

- Tile area: mean 1354 mm² (about 3.7×3.7 cm). Spread 37%, minimum 288 mm², maximum 2620 mm².
- A 12 mm pawn fits in every tile. All tiles are reachable.
- Passages: Suez Canal + Red Sea (Mediterranean to Arabian Sea), Panama Canal, Strait of Gibraltar.

## Open points and known issues

1. **Seas left out by the pawn rule** (Baltic, Black Sea, Red Sea, Persian Gulf and others). Getting them back needs a bigger board or a smaller pawn. Even an 80×53 cm board makes the Red Sea only about 6 mm wide.
2. **Seas that are not regions** fold into a neighbour (e.g. the Java Sea into the Indian Ocean).
3. **Sargasso Sea** has no coasts in the data, so its tile is a rounded rectangle in mid-Atlantic. Decide: keep it, bend it, or drop it.
4. **Labels:** names now avoid tile numbers. Where an edge crossing is only a few millimetres long, its arrow can still sit close to a pawn circle (for example 87/105 on the right edge).
5. **The Arctic is cut at 84°N**, so a pawn cannot sail over the pole.
6. **Day track:** the design is a first proposal (squares, colours, language, position).
7. **Gameplay** (threat, roles, what the days mean) is not designed yet; this plan only covers the board.
