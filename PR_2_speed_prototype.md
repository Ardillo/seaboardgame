# PR 2: speed prototype for Generate (single core)

Status: prototype made and measured on 2026-11-22 on a throwaway copy of `main` (`6704b7b`).
**Built into `src/make_tiles.py` by PR 2 (2026-11-25)**, with the notes under "Notes for the real PR" done
(except the further search gain, not tried). This file records exactly what the
prototype changed, why the board stays the same, and how that was checked, so the PR can repeat it.

## Result

Tile generation (`make_tiles.py`) with the settings in `src/config.yaml`, pinned to one CPU core:

| | Time | Peak memory | Output |
|---|--:|--:|---|
| `main` now | 318 s | 754 MB | reference |
| prototype | **76 s** | 746 MB | **byte-identical** `labels.npy`, `tiles.json`, `borders.json`, `report.txt`, `preview.png` |

The rest of Generate stays as it is: the atlas map takes 5 s and building the design 1 s.

## Where the time went

Profile of `main` (336 s on this machine, not pinned):

- `relax()`: 303 s. Most of it (about 260 s) is `geodesic_voronoi`, a shortest-path search over the whole
  3.5 million pixel map, run 246 times: 6 layout rounds (`refine_rounds` 5, plus the final one) × 41 relaxation
  steps (`lloyd_iterations` 40, plus one).
- The rest: whole-map scans for small things (`np.nonzero`, `ndimage.label`, `binary_dilation`, a stable
  `argsort` of all pixels on every step), each 6–10 s.
- One search pass took 0.59, 1.08 or 2.45 s depending on the core it ran on, so the same run can take 3–4×
  longer on a slow core. That explains 400+ s on another machine.

## The changes

All of them are in `src/make_tiles.py`. The full diff against `main` is at the end.

1. **Bucket queue instead of a binary heap** in `geodesic_voronoi`. Every step costs at least the lowest cost
   factor `lo` (`cf` is clipped at 0.2, so `lo` > 0). Buckets are `0.999 × lo` wide, so a pixel taken from
   the current bucket can never be improved by another pixel in the same bucket: its distance is final without
   sorting. The queue is a ring of `K` buckets (enough for the most expensive step) that grows when one is full.
2. **Same tie rule as the heap.** The heap took pixels in order of (distance, pixel index). When two routes reach
   a pixel at exactly the same distance, the route through the predecessor with the lower (distance, pixel)
   wins, so labels stay the same. This matters without border wiggle, where many distances tie.
   Each pixel stores its predecessor (`par`) for this.
3. **Each sea piece is searched on its own crop.** Searches never cross from one sea piece ("unit") to another,
   so each unit is cut out once per refine round (`find_objects`) and searched alone. Pixels keep their row-major
   order inside the crop, so the tie order does not change.
4. **A unit with one tile needs no search.** All its pixels get that tile. This holds because every unit is one
   4-connected piece, which the search always fills completely.
5. **Centroids in one compiled pass** (`centroid_pixels`). This replaces the whole-map stable `argsort`,
   `bincount` and `searchsorted` on every relaxation step. Per tile it finds the pixel nearest to the centroid;
   on equal distance the first in row-major order wins, as with the stable sort.
6. **Crops instead of whole-map scans**: `pole_of_inaccessibility` (bounding box from `any()` instead of
   `nonzero`), the "merge small detached pieces" loop and the "every tile one piece" clean-up work on a box
   around the piece. `farthest_point_seeds` gets its coordinates from the unit crop.
   `rows_idx` and `cols_idx` (two whole-map index arrays) are no longer needed.

## How "same board" was checked

The `main` code and the prototype were run with the same settings, and `labels.npy`, `tiles.json`,
`borders.json` and `report.txt` were compared byte by byte (`cmp`). They were identical in all 10 runs:

| Settings (on top of `src/config.yaml`) |
|---|
| none (the real board: 5 refine rounds, 40 steps) |
| `tiles.count=100 tiles.random_seed=11 tiles.lloyd_iterations=6 tiles.refine_rounds=2 compose.language=nl map.center_lon=150` |
| `tiles.border_noise=0` (no wiggle: many exact ties) |
| `tiles.border_noise=0.9` |
| `tiles.random_seed=99 tiles.count=150` |
| `map.projection=equirectangular map.lat_north=80 map.lat_south=-78` |
| `tiles.raster_px_per_mm=2` |
| `tiles.count=50 tiles.pawn_diameter_mm=8` |
| `tiles.sea_border_wiggle_mm=0 tiles.border_noise=0 tiles.raster_px_per_mm=2` |
| `tiles.pawn_diameter_mm=16` |

The last eight used `refine_rounds=1` and 4–8 relaxation steps to save time; they run the same code.

To repeat one comparison (from `src/`, with the old and the new script side by side, on one core):

```bash
taskset -c 0 ../.venv/bin/python make_tiles.py     --set output_dir=/tmp/old --set tiles.border_noise=0
taskset -c 0 ../.venv/bin/python make_tiles_new.py --set output_dir=/tmp/new --set tiles.border_noise=0
for f in labels.npy tiles.json borders.json report.txt; do cmp /tmp/old/tiles/$f /tmp/new/tiles/$f && echo "same $f"; done
```

## Fewer rounds, steps or pixels (measured, not part of the prototype)

On top of the prototype. Times are seed 7 on one core. "Same" is the share of the map that lands in the same
tile. "Over-wide" counts tiles wider than 1.6× an average tile. The ranges cover seeds 7, 11 and 23.

| Setting | Time | Same | Over-wide |
|---|--:|--:|---|
| reference (40 steps, 5 rounds, 4 px/mm) | 76 s | 100% | 4–10 |
| `lloyd_iterations=20` | 47 s | 95% | +1 on every seed |
| `lloyd_iterations=10` | 33 s | 83–89% | −2 to +2; the tile count shifts |
| `refine_rounds=3` | 55 s | 89–91% | +3 to +4 on every seed |
| `raster_px_per_mm=3` | 43 s | not comparable | coarser borders, pawn margin 12.0 mm |

Advice: keep `refine_rounds` and the resolution. `lloyd_iterations=20` is acceptable; whether to use it is still
open in `PLAN.md`.

## Notes for the real PR

- The remaining 76 s is still about 70% search (0.22 s per pass). A further exact gain may be possible (for
  example by working out once which neighbours each pixel can reach); not tried.
- The prototype skips a tile in the "every tile one piece" loop when it had no pixels at the start of that pass
  (`found[t] is None`). The old code would still check it if it gained pixels during the same pass. It made no
  difference in the 10 runs, but the PR should drop that check: the `any()` check below it is enough.
- `import heapq` is no longer used.
- The fragment loop still compares the whole map per tile (`lab == t`); that can use the crop as well.
- Keep numba's `cache=True`: the first compile takes about 2.5 s.
- Turn the comparisons above into an automatic test (with the reference outputs from PR 1), including one run
  without wiggle.

## Full diff against `main`

```diff
--- a/src/make_tiles.py
+++ b/src/make_tiles.py
@@ -23,60 +23,143 @@
 # ------------------------------------------------------------ geodesic voronoi
 @njit(cache=True)
 def geodesic_voronoi(unit, cf, seeds, w, seed_lab):
-    """Multi-source Dijkstra over the pixel grid.
+    """Multi-source Dijkstra with a bucket queue.
 
-    unit: int32 HxW, -1 = blocked; paths never cross into another unit id.
-    cf:   float32 HxW cost factor (border wiggles).
-    seeds: flat pixel indices, w: start cost per seed, seed_lab: label per seed.
-    No corner cutting between two blocked pixels, no wrap at the map edges.
+    A bucket is narrower than the cheapest step, so everything in it is final.
+    On a tie the predecessor with the lowest (distance, pixel) wins.
     """
     H, W = unit.shape
+    N = H * W
     uf = unit.ravel()
     cff = cf.ravel()
-    dist = np.full(H * W, np.inf)
-    lab = np.full(H * W, -1, np.int32)
-    heap = [(0.0, np.int64(0), np.int32(0))]
-    heap.pop()
+    lo = np.inf
+    hi = 0.0
+    for p in range(N):
+        if uf[p] >= 0:
+            lo = min(lo, cff[p])
+            hi = max(hi, cff[p])
+    dist = np.full(N, np.inf)
+    lab = np.full(N, -1, np.int32)
+    if hi == 0:
+        return lab.reshape(H, W), dist.reshape(H, W)
+    inv = 1.0 / (lo * 0.999)
+    K = int(1.41421356 * hi * inv) + 3
+    par = np.full(N, -1, np.int32)
+    done = np.zeros(N, np.uint8)
     for k in range(len(seeds)):
         p = seeds[k]
-        if uf[p] < 0:
-            continue
-        if w[k] < dist[p]:
+        if uf[p] >= 0 and w[k] < dist[p]:
             dist[p] = w[k]
             lab[p] = seed_lab[k]
-            heapq.heappush(heap, (w[k], p, seed_lab[k]))
-    while len(heap) > 0:
-        d, p, l = heapq.heappop(heap)
-        if d > dist[p]:
-            continue
-        r = p // W
-        c = p - r * W
-        u = uf[p]
-        for dr in range(-1, 2):
-            for dc in range(-1, 2):
-                if dr == 0 and dc == 0:
-                    continue
-                rr = r + dr
-                cc = c + dc
-                if rr < 0 or rr >= H or cc < 0 or cc >= W:
-                    continue
-                q = rr * W + cc
-                if uf[q] != u:
-                    continue
-                if dr != 0 and dc != 0:
-                    if uf[r * W + cc] != u or uf[rr * W + c] != u:
+    order = np.argsort(w, kind="mergesort")
+    cap = 4096
+    queue = np.empty((K, cap), np.int32)
+    size = np.zeros(K, np.int64)
+    queued = 0
+    si = 0
+    cur = 0
+    ns = len(seeds)
+    while queued > 0 or si < ns:
+        if queued == 0:
+            cur = max(cur, int(w[order[si]] * inv))
+        b = cur % K
+        while si < ns and int(w[order[si]] * inv) <= cur:
+            p = seeds[order[si]]
+            si += 1
+            if uf[p] < 0 or done[p] or par[p] >= 0:
+                continue
+            if size[b] == cap:
+                grown = np.empty((K, cap * 2), np.int32)
+                grown[:, :cap] = queue
+                queue = grown
+                cap *= 2
+            queue[b, size[b]] = p
+            size[b] += 1
+            queued += 1
+        for i in range(size[b]):
+            p = np.int64(queue[b, i])
+            if done[p]:
+                continue
+            d = dist[p]
+            if int(d * inv) != cur:
+                continue
+            done[p] = 1
+            r = p // W
+            c = p - r * W
+            u = uf[p]
+            for dr in range(-1, 2):
+                for dc in range(-1, 2):
+                    rr = r + dr
+                    cc = c + dc
+                    if rr < 0 or rr >= H or cc < 0 or cc >= W:
                         continue
-                    step = 1.41421356
-                else:
-                    step = 1.0
-                nd = d + step * 0.5 * (cff[p] + cff[q])
-                if nd < dist[q]:
-                    dist[q] = nd
-                    lab[q] = l
-                    heapq.heappush(heap, (nd, q, l))
+                    q = rr * W + cc
+                    if done[q] or uf[q] != u:
+                        continue
+                    if dr != 0 and dc != 0:
+                        if uf[r * W + cc] != u or uf[rr * W + c] != u:
+                            continue
+                        step = 1.41421356
+                    else:
+                        step = 1.0
+                    nd = d + step * 0.5 * (cff[p] + cff[q])
+                    old = dist[q]
+                    if nd < old:
+                        to = int(nd * inv)
+                        push = par[q] < 0 or int(old * inv) != to
+                        dist[q] = nd
+                        lab[q] = lab[p]
+                        par[q] = p
+                        if push:
+                            t = to % K
+                            if size[t] == cap:
+                                grown = np.empty((K, cap * 2), np.int32)
+                                grown[:, :cap] = queue
+                                queue = grown
+                                cap *= 2
+                            queue[t, size[t]] = q
+                            size[t] += 1
+                            queued += 1
+                    elif nd == old and par[q] >= 0:
+                        o = par[q]
+                        if d < dist[o] or (d == dist[o] and p < o):
+                            lab[q] = lab[p]
+                            par[q] = p
+        queued -= size[b]
+        size[b] = 0
+        cur += 1
     return lab.reshape(H, W), dist.reshape(H, W)
 
 
+@njit(cache=True)
+def centroid_pixels(lab, n):
+    H, W = lab.shape
+    area = np.zeros(n, np.int64)
+    sr = np.zeros(n)
+    sc = np.zeros(n)
+    for r in range(H):
+        for c in range(W):
+            t = lab[r, c]
+            if t >= 0:
+                area[t] += 1
+                sr[t] += r
+                sc[t] += c
+    for t in range(n):
+        sr[t] /= max(area[t], 1)
+        sc[t] /= max(area[t], 1)
+    bd = np.full(n, np.inf)
+    best = np.full(n, -1, np.int64)
+    for r in range(H):
+        for c in range(W):
+            t = lab[r, c]
+            if t >= 0:
+                d = (r - sr[t]) * (r - sr[t]) + (c - sc[t]) * (c - sc[t])
+                if d < bd[t]:
+                    bd[t] = d
+                    best[t] = r * W + c
+    return area, best
+
+
 # ------------------------------------------------------------ helpers
 def components_wrapped(mask):
     """4-connected components; pieces touching both side edges are joined (world wraps)."""
@@ -141,8 +224,8 @@
 
 def pole_of_inaccessibility(mask):
     """Pixel deepest inside mask and its distance to the edge (pixels)."""
-    rows, cols = np.nonzero(mask)
-    r0, r1, c0, c1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
+    rows, cols = np.flatnonzero(mask.any(1)), np.flatnonzero(mask.any(0))
+    r0, r1, c0, c1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
     sub = np.pad(mask[r0:r1, c0:c1], 1)
     dt = ndimage.distance_transform_edt(sub)
     r, c = np.unravel_index(int(np.argmax(dt)), dt.shape)
@@ -330,17 +413,21 @@
             if n <= 1:
                 continue
             cs = np.bincount(lab.ravel())[1:]
+            cs_max = cs.max()
+            found = ndimage.find_objects(lab)
             for i, s in enumerate(cs):
-                if s < 0.25 * target_px and s < cs.max():
-                    piece = lab == i + 1
-                    around = region[ndimage.binary_dilation(piece) & ~piece]
+                if s < 0.25 * target_px and s < cs_max:
+                    rs_, cs__ = found[i]
+                    box = np.s_[max(rs_.start - 1, 0):rs_.stop + 1, max(cs__.start - 1, 0):cs__.stop + 1]
+                    piece = lab[box] == i + 1
+                    around = region[box][ndimage.binary_dilation(piece) & ~piece]
                     if not ((around >= 0) & (around != r)).any():
                         if s < 0.1 * target_px:     # scrap at the map edge: not playable
-                            region[piece] = -1
-                            water[piece] = False
+                            region[box][piece] = -1
+                            water[box][piece] = False
                             changed = True
                         continue        # closed basin: stays a piece of its own (the pawn rule below decides)
-                    region[piece] = -2
+                    region[box][piece] = -2
                     changed = True
         if not changed:
             break
@@ -406,13 +493,29 @@
 
     cf = (1.0 + tc["border_noise"] * fbm_noise((H, W), tc["noise_scale_mm"] * ppm, rng)).astype(np.float32)
     cf[cf < 0.2] = 0.2
-    rows_idx, cols_idx = np.indices((H, W))
+
+    boxes = ndimage.find_objects(unit_map + 1, max_label=len(units))
+    insides = [unit_map[bx] == i for i, bx in enumerate(boxes)]
+    crops = [(np.where(m, 0, -1).astype(np.int32), cf[bx].copy()) for bx, m in zip(boxes, insides)]
+
+    def voronoi_units(seed_xy, seed_unit, weights):
+        out = np.full((H, W), -1, np.int32)
+        for ui, bx in enumerate(boxes):
+            mine = np.flatnonzero(seed_unit == ui)
+            if len(mine) == 1:
+                np.copyto(out[bx], mine[0], where=insides[ui])
+                continue
+            unit, cost = crops[ui]
+            at = ((seed_xy[mine, 0] - bx[0].start) * unit.shape[1] + seed_xy[mine, 1] - bx[1].start).astype(np.int64)
+            part = geodesic_voronoi(unit, cost, at, weights[mine], mine.astype(np.int32))[0]
+            np.copyto(out[bx], part, where=insides[ui])
+        return out
 
     def relax(alloc):
         """Seed the tiles of every unit and run Lloyd relaxation with area balancing."""
         seed_xy, seed_unit = [], []
         for ui, k in enumerate(alloc):
-            coords = np.argwhere(unit_map == ui)
+            coords = np.argwhere(insides[ui]) + (boxes[ui][0].start, boxes[ui][1].start)
             for rc in farthest_point_seeds(coords, int(k), rng):
                 seed_xy.append(rc)
                 seed_unit.append(ui)
@@ -423,31 +526,19 @@
         tgt = (np.array([u["px"] for u in units]) / alloc)[seed_unit]
         rad = np.sqrt(tgt / math.pi)
         for it in range(tc["lloyd_iterations"] + 1):
-            seeds = (seed_xy[:, 0] * W + seed_xy[:, 1]).astype(np.int64)
-            lab, _ = geodesic_voronoi(unit_map, cf, seeds, weights, np.arange(n_t, dtype=np.int32))
+            lab = voronoi_units(seed_xy, seed_unit, weights)
             if it == tc["lloyd_iterations"]:
                 break
-            flat = lab.ravel()
-            ok = flat >= 0
-            area = np.bincount(flat[ok], minlength=n_t)
-            cy = np.bincount(flat[ok], rows_idx.ravel()[ok], minlength=n_t) / np.maximum(area, 1)
-            cx = np.bincount(flat[ok], cols_idx.ravel()[ok], minlength=n_t) / np.maximum(area, 1)
-            order = np.argsort(flat[ok], kind="stable")
-            pix = np.flatnonzero(ok)[order]
-            bounds = np.searchsorted(flat[ok][order], np.arange(n_t + 1))
+            area, best = centroid_pixels(lab, n_t)
             for t in range(n_t):
-                mine = pix[bounds[t]:bounds[t + 1]]
-                if len(mine) == 0:      # lost its cell: restart in the biggest tile of the unit
+                if best[t] < 0:         # lost its cell: restart in the biggest tile of the unit
                     same = np.flatnonzero(seed_unit == seed_unit[t])
-                    big = same[np.argmax(area[same])]
-                    bm = pix[bounds[big]:bounds[big + 1]]
+                    bm = np.flatnonzero(lab == same[np.argmax(area[same])])
                     p = bm[rng.integers(len(bm))]
                     seed_xy[t] = (p // W, p % W)
                     weights[t] = 0
                     continue
-                rr, cc = mine // W, mine % W
-                j = int(np.argmin((rr - cy[t]) ** 2 + (cc - cx[t]) ** 2))
-                seed_xy[t] = (rr[j], cc[j])
+                seed_xy[t] = (best[t] // W, best[t] % W)
             weights += 0.6 * (area / tgt - 1.0) * rad
             for ui in range(len(units)):
                 sel = seed_unit == ui
@@ -456,8 +547,18 @@
         # every tile one 4-connected piece
         for _ in range(10):
             moved = 0
+            found = ndimage.find_objects(lab + 1, max_label=n_t)
             for t in range(n_t):
-                cl, n = ndimage.label(lab == t)
+                if found[t] is None:
+                    continue
+                # the tile can only have grown into pixels next to it since `found`: take a fresh box
+                mask = lab == t
+                rs, cs = np.flatnonzero(mask.any(1)), np.flatnonzero(mask.any(0))
+                if not len(rs):
+                    continue
+                box = np.s_[max(rs[0] - 1, 0):rs[-1] + 2, max(cs[0] - 1, 0):cs[-1] + 2]
+                part = lab[box]
+                cl, n = ndimage.label(mask[box])
                 if n <= 1:
                     continue
                 keep = np.argmax(np.bincount(cl.ravel())[1:]) + 1
@@ -466,9 +567,9 @@
                         continue
                     frag = cl == i
                     ring = ndimage.binary_dilation(frag) & ~frag
-                    cand = [v for v in lab[ring] if v >= 0 and v != t]
+                    cand = [v for v in part[ring] if v >= 0 and v != t]
                     if cand:
-                        lab[frag] = Counter(cand).most_common(1)[0][0]
+                        part[frag] = Counter(cand).most_common(1)[0][0]
                         moved += 1
             if not moved:
                 break
```
