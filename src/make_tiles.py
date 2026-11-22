"""Build the sea tiles: sea regions, equal-ish tiles inside them, neighbours, borders.

Output (in <output_dir>/tiles/):
  tiles.json    tiles, sea regions, neighbours, passages, pawn spots (board mm)
  borders.json  smoothed tile and region border lines (board mm)
  labels.npy    tile id per raster pixel (-1 = land / not playable)
  preview.png   quick colour check of the layout
  report.txt    size statistics and warnings
"""
import colorsys
import heapq
import math
from collections import Counter, defaultdict, deque
from pathlib import Path

import numpy as np
from numba import njit
from scipy import ndimage

from board_common import Projection, load_config, parse_args, rasterize, read_rings, save_json


# ------------------------------------------------------------ geodesic voronoi
@njit(cache=True)
def geodesic_voronoi(unit, cf, seeds, w, seed_lab):
    """Multi-source Dijkstra over the pixel grid.

    unit: int32 HxW, -1 = blocked; paths never cross into another unit id.
    cf:   float32 HxW cost factor (border wiggles).
    seeds: flat pixel indices, w: start cost per seed, seed_lab: label per seed.
    No corner cutting between two blocked pixels, no wrap at the map edges.
    """
    H, W = unit.shape
    uf = unit.ravel()
    cff = cf.ravel()
    dist = np.full(H * W, np.inf)
    lab = np.full(H * W, -1, np.int32)
    heap = [(0.0, np.int64(0), np.int32(0))]
    heap.pop()
    for k in range(len(seeds)):
        p = seeds[k]
        if uf[p] < 0:
            continue
        if w[k] < dist[p]:
            dist[p] = w[k]
            lab[p] = seed_lab[k]
            heapq.heappush(heap, (w[k], p, seed_lab[k]))
    while len(heap) > 0:
        d, p, l = heapq.heappop(heap)
        if d > dist[p]:
            continue
        r = p // W
        c = p - r * W
        u = uf[p]
        for dr in range(-1, 2):
            for dc in range(-1, 2):
                if dr == 0 and dc == 0:
                    continue
                rr = r + dr
                cc = c + dc
                if rr < 0 or rr >= H or cc < 0 or cc >= W:
                    continue
                q = rr * W + cc
                if uf[q] != u:
                    continue
                if dr != 0 and dc != 0:
                    if uf[r * W + cc] != u or uf[rr * W + c] != u:
                        continue
                    step = 1.41421356
                else:
                    step = 1.0
                nd = d + step * 0.5 * (cff[p] + cff[q])
                if nd < dist[q]:
                    dist[q] = nd
                    lab[q] = l
                    heapq.heappush(heap, (nd, q, l))
    return lab.reshape(H, W), dist.reshape(H, W)


# ------------------------------------------------------------ helpers
def components_wrapped(mask):
    """4-connected components; pieces touching both side edges are joined (world wraps)."""
    lab, n = ndimage.label(mask)
    parent = np.arange(n + 1)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in zip(lab[:, 0], lab[:, -1]):
        if a and b:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra
    roots = np.array([find(i) for i in range(n + 1)])
    return roots[lab]


def fbm_noise(shape, cell_px, rng, octaves=3):
    h, w = shape
    total = np.zeros(shape, np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        cp = max(cell_px / (2 ** o), 2)
        gh, gw = int(h / cp) + 3, int(w / cp) + 3
        grid = rng.standard_normal((gh, gw)).astype(np.float32)
        up = ndimage.zoom(grid, (h / (gh - 2), w / (gw - 2)), order=3)[:h, :w]
        total += amp * up
        norm += amp
        amp *= 0.5
    total /= norm
    return np.clip(total / (np.abs(total).max() + 1e-9), -1, 1)


def farthest_point_seeds(coords, k, rng):
    """Spread k seeds over a set of pixel coords (N x 2)."""
    sub = coords if len(coords) <= 200_000 else coords[rng.choice(len(coords), 200_000, replace=False)]
    chosen = [sub[rng.integers(len(sub))]]
    d = np.full(len(sub), np.inf)
    for _ in range(k - 1):
        d = np.minimum(d, ((sub - chosen[-1]) ** 2).sum(1))
        chosen.append(sub[int(np.argmax(d))])
    return np.array(chosen)


def largest_remainder(weights, total, minimum=1):
    weights = np.asarray(weights, float)
    n = len(weights)
    if total < n * minimum:
        raise SystemExit(f"tiles.count={total} is lower than the number of sea areas ({n}). "
                         "Raise tiles.count or include fewer seas.")
    extra = total - n * minimum
    share = weights / weights.sum() * extra
    alloc = np.floor(share).astype(int)
    rest = extra - alloc.sum()
    alloc[np.argsort(-(share - alloc))[:rest]] += 1
    return alloc + minimum


def pole_of_inaccessibility(mask):
    """Pixel deepest inside mask and its distance to the edge (pixels)."""
    rows, cols = np.nonzero(mask)
    r0, r1, c0, c1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
    sub = np.pad(mask[r0:r1, c0:c1], 1)
    dt = ndimage.distance_transform_edt(sub)
    r, c = np.unravel_index(int(np.argmax(dt)), dt.shape)
    return r0 + r - 1, c0 + c - 1, float(dt[r, c])


def chaikin(pts, iterations=3, closed=False):
    for _ in range(iterations):
        if len(pts) < 3:
            return pts
        a = pts if closed else pts[:-1]
        b = np.roll(pts, -1, axis=0) if closed else pts[1:]
        q = 0.75 * a + 0.25 * b
        r = 0.25 * a + 0.75 * b
        mid = np.empty((2 * len(a), 2))
        mid[0::2], mid[1::2] = q, r
        pts = mid if closed else np.vstack([pts[:1], mid, pts[-1:]])
    return pts


def chain_segments(segs):
    """Join unit segments (pairs of vertex ids) into polylines of vertex ids."""
    inc = defaultdict(list)
    for i, (a, b) in enumerate(segs):
        inc[a].append(i)
        inc[b].append(i)
    used = np.zeros(len(segs), bool)
    lines = []

    def walk(start_v, seg):
        line = [start_v]
        v = start_v
        while True:
            used[seg] = True
            a, b = segs[seg]
            v = b if a == v else a
            line.append(v)
            if len(inc[v]) != 2:
                return line, False
            nxt = [s for s in inc[v] if not used[s]]
            if not nxt:
                return line, True
            seg = nxt[0]

    for v, ss in inc.items():
        if len(ss) != 2:
            for s in ss:
                if not used[s]:
                    lines.append(walk(v, s))
    for s in range(len(segs)):
        if not used[s]:
            lines.append(walk(segs[s][0], s))
    return lines


def sphere_area_km2(rings):
    """Area on the sphere via the cylindrical equal-area projection (holes subtract)."""
    R = 6371.0
    a = 0.0
    for r in rings:
        x = np.radians(np.degrees(np.unwrap(np.radians(r[:, 0]))))
        y = np.sin(np.radians(r[:, 1]))
        a += 0.5 * (np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
    return abs(a) * R * R


def nice_name(name):
    return name.title() if name.isupper() else name


# ------------------------------------------------------------ main
def main():
    args = parse_args(__doc__)
    cfg = load_config(args)
    tc, sc = cfg["tiles"], cfg["seas"]
    proj = Projection(cfg)
    ppm = float(tc["raster_px_per_mm"])
    H, W = int(round(proj.map_h * ppm)), int(round(proj.width * ppm))
    rng = np.random.default_rng(tc["random_seed"])
    data = Path(cfg["data_dir"])
    out = Path(cfg["output_dir"]) / "tiles"
    out.mkdir(parents=True, exist_ok=True)
    log = []

    def say(msg):
        print(msg)
        log.append(msg)

    say(f"board {proj.width:.0f}x{proj.board_h:.0f} mm, map {proj.map_h:.1f} mm tall, "
        f"bottom panel {proj.panel_h:.1f} mm; raster {W}x{H} px")

    # --- land / water
    def land_rings():
        for shp in ("ne_50m_land/ne_50m_land.shp",
                    "ne_50m_antarctic_ice_shelves_polys/ne_50m_antarctic_ice_shelves_polys.shp"):
            for _, rings in read_rings(data / shp):
                yield None, rings
    land = rasterize(land_rings(), proj, ppm, (H, W), lambda k: 1) > 0
    water = ~land
    comp = components_wrapped(water)
    sizes = np.bincount(comp.ravel())
    min_px = tc["min_water_component_mm2"] * ppm * ppm
    small = (sizes < min_px)[comp] & water
    water &= ~small

    # --- sea regions from Natural Earth marine areas
    feats = defaultdict(list)
    meta = {}
    for rec, rings in read_rings(data / "ne_10m_geography_marine_polys/ne_10m_geography_marine_polys.shp"):
        name, cls = rec["name"], rec["featurecla"]
        if name in sc["exclude_names"]:
            continue
        if cls != "ocean" and cls not in sc["candidate_classes"] and name not in sc["include_names"]:
            continue
        feats[name].extend(rings)
        meta[name] = {"name": nice_name(name), "name_nl": rec.get("name_nl") or nice_name(name),
                      "class": cls}
    for n in feats:
        meta[n]["area_km2"] = round(sphere_area_km2(feats[n]))
    cands = sorted((n for n in feats if meta[n]["class"] != "ocean"), key=lambda n: -meta[n]["area_km2"])
    keep = {n for n in feats if meta[n]["class"] == "ocean"} | set(cands[:sc["biggest"]]) \
        | (set(sc["include_names"]) & set(feats))
    for n in list(feats):
        if n not in keep:
            del feats[n]
    say("seas: " + ", ".join(f"{meta[n]['name']} ({meta[n]['area_km2'] / 1e3:.0f}k km2)"
                             for n in sorted(feats, key=lambda n: -meta[n]["area_km2"])))

    def proj_area(rings):
        a = 0.0
        for r in rings:
            x, y = proj.forward(r[:, 0], r[:, 1])
            s = 0.5 * (np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
            a += s
        return abs(a)

    names = sorted(feats, key=lambda n: -proj_area(feats[n]))   # big first, small seas on top
    rid = {n: i for i, n in enumerate(names)}
    region = rasterize(((n, feats[n]) for n in names), proj, ppm, (H, W), lambda n: rid[n] + 1) - 1
    region[~water] = -1

    # Natural straits that the raster closes: let the sea fill pass through them
    # (only for deciding which sea a basin belongs to; canals do not count).
    from PIL import Image, ImageDraw
    strait_img = Image.new("L", (W, H), 0)
    sd = ImageDraw.Draw(strait_img)
    for p in cfg["passages"]:
        if p.get("enabled", True) and p["kind"] == "strait":
            (ax, ay), (bx, by) = (proj.forward(*p["a"]), proj.forward(*p["b"]))
            sd.line([(float(ax) * ppm, float(ay) * ppm), (float(bx) * ppm, float(by) * ppm)], fill=1, width=3)
    straits = np.asarray(strait_img) > 0

    def fill_unassigned(region, use_straits=True):
        assigned = region >= 0
        flow = (water | straits) if use_straits else water
        edge = assigned & ndimage.binary_dilation(flow & ~assigned)
        unit = np.where((flow & ~assigned) | edge, 0, -1).astype(np.int32)
        seeds = np.flatnonzero(edge).astype(np.int64)
        lab, _ = geodesic_voronoi(unit, np.ones((H, W), np.float32), seeds,
                                  np.zeros(len(seeds)), region.ravel()[seeds].astype(np.int32))
        return np.where(assigned, region, np.where(water, lab, -1))

    region = fill_unassigned(region)

    # make the (often ruler-straight) sea borders organic: sample the region map
    # through a smooth random displacement field
    amp = tc["sea_border_wiggle_mm"] * ppm
    if amp > 0:
        cell = tc["noise_scale_mm"] * 2 * ppm
        dy = fbm_noise((H, W), cell, rng) * amp
        dx = fbm_noise((H, W), cell, rng) * amp
        rr, cc = np.indices((H, W))
        sr = np.clip(np.round(rr + dy).astype(int), 0, H - 1)
        sc_ = np.clip(np.round(cc + dx).astype(int), 0, W - 1)
        warped = region[sr, sc_]
        region = np.where(water & (warped >= 0), warped, region)

    # merge small detached pieces of a region into their neighbours
    target_px = water.sum() / tc["count"]
    for _ in range(3):
        changed = False
        for r in range(len(names)):
            lab, n = ndimage.label(region == r)
            if n <= 1:
                continue
            cs = np.bincount(lab.ravel())[1:]
            for i, s in enumerate(cs):
                if s < 0.25 * target_px and s < cs.max():
                    piece = lab == i + 1
                    around = region[ndimage.binary_dilation(piece) & ~piece]
                    if not ((around >= 0) & (around != r)).any():
                        if s < 0.1 * target_px:     # scrap at the map edge: not playable
                            region[piece] = -1
                            water[piece] = False
                            changed = True
                        continue        # closed basin (e.g. Black Sea): keeps its own tile
                    region[piece] = -2
                    changed = True
        if not changed:
            break
        hole = region == -2
        region[hole] = -1
        region = fill_unassigned(region)
    unplayable = water & (region < 0)
    if unplayable.any():
        say(f"note: {unplayable.sum() / ppm**2:.0f} mm2 of water is not reachable and not playable")
    water &= region >= 0


    pawn_px = tc["pawn_diameter_mm"] * ppm

    def build_units(region):
        """Connected pieces of each sea (the seam splits e.g. the Pacific)."""
        units = []
        unit_map = np.full((H, W), -1, np.int32)
        for r in range(len(names)):
            lab, n = ndimage.label(region == r)
            for i in range(1, n + 1):
                m = lab == i
                unit_map[m] = len(units)
                units.append({"region": r, "px": int(m.sum()),
                              "fit_px": 2 * pole_of_inaccessibility(m)[2]})
        return units, unit_map

    # --- rule: a sea (piece) where no pawn fits is not drawn; it joins the sea
    # it touches, or becomes unplayable when it is closed off
    dropped = set()
    for _ in range(6):
        units, unit_map = build_units(region)
        bad = [i for i, u in enumerate(units) if u["fit_px"] < pawn_px]
        if not bad:
            break
        merged = False
        for i in bad:
            m = unit_map == i
            # open sea (long shared edge with other seas) joins its neighbours;
            # a narrow inlet or a closed-off sea is left out
            ring = ndimage.binary_dilation(m) & ~m
            contact = int(((region >= 0) & ring & ~m).sum())
            openness = contact / math.sqrt(units[i]["px"])
            name = names[units[i]["region"]]
            region[m] = -1
            if openness >= tc["open_sea_contact"]:
                merged = True
                say(f"  {meta[name]['name']}: no room for a pawn, open sea (contact {openness:.2f}) -> joins neighbours")
            else:
                water[m] = False
                say(f"  {meta[name]['name']}: no room for a pawn, inlet/closed (contact {openness:.2f}) -> left out")
            dropped.add(name)
        if merged:
            region = fill_unassigned(region, use_straits=False)
            water &= region >= 0
    present = sorted({u["region"] for u in units})
    gone = sorted(n for n in dropped if rid[n] not in present)
    if gone:
        say(f"no own sea any more (a {tc['pawn_diameter_mm']} mm pawn does not fit): "
            + ", ".join(meta[n]["name"] for n in gone))
    for r in set(range(len(names))) - set(present) - {rid[n] for n in dropped}:
        say(f"warning: sea '{names[r]}' has no water on the map and is skipped")

    cf = (1.0 + tc["border_noise"] * fbm_noise((H, W), tc["noise_scale_mm"] * ppm, rng)).astype(np.float32)
    cf[cf < 0.2] = 0.2
    rows_idx, cols_idx = np.indices((H, W))

    def relax(alloc):
        """Seed the tiles of every unit and run Lloyd relaxation with area balancing."""
        seed_xy, seed_unit = [], []
        for ui, k in enumerate(alloc):
            coords = np.argwhere(unit_map == ui)
            for rc in farthest_point_seeds(coords, int(k), rng):
                seed_xy.append(rc)
                seed_unit.append(ui)
        seed_xy = np.array(seed_xy)
        seed_unit = np.array(seed_unit)
        n_t = len(seed_xy)
        weights = np.zeros(n_t)
        tgt = (np.array([u["px"] for u in units]) / alloc)[seed_unit]
        rad = np.sqrt(tgt / math.pi)
        for it in range(tc["lloyd_iterations"] + 1):
            seeds = (seed_xy[:, 0] * W + seed_xy[:, 1]).astype(np.int64)
            lab, _ = geodesic_voronoi(unit_map, cf, seeds, weights, np.arange(n_t, dtype=np.int32))
            if it == tc["lloyd_iterations"]:
                break
            flat = lab.ravel()
            ok = flat >= 0
            area = np.bincount(flat[ok], minlength=n_t)
            cy = np.bincount(flat[ok], rows_idx.ravel()[ok], minlength=n_t) / np.maximum(area, 1)
            cx = np.bincount(flat[ok], cols_idx.ravel()[ok], minlength=n_t) / np.maximum(area, 1)
            order = np.argsort(flat[ok], kind="stable")
            pix = np.flatnonzero(ok)[order]
            bounds = np.searchsorted(flat[ok][order], np.arange(n_t + 1))
            for t in range(n_t):
                mine = pix[bounds[t]:bounds[t + 1]]
                if len(mine) == 0:      # lost its cell: restart in the biggest tile of the unit
                    same = np.flatnonzero(seed_unit == seed_unit[t])
                    big = same[np.argmax(area[same])]
                    bm = pix[bounds[big]:bounds[big + 1]]
                    p = bm[rng.integers(len(bm))]
                    seed_xy[t] = (p // W, p % W)
                    weights[t] = 0
                    continue
                rr, cc = mine // W, mine % W
                j = int(np.argmin((rr - cy[t]) ** 2 + (cc - cx[t]) ** 2))
                seed_xy[t] = (rr[j], cc[j])
            weights += 0.6 * (area / tgt - 1.0) * rad
            for ui in range(len(units)):
                sel = seed_unit == ui
                weights[sel] -= weights[sel].min()
            weights = np.minimum(weights, 0.8 * rad)
        # every tile one 4-connected piece
        for _ in range(10):
            moved = 0
            for t in range(n_t):
                cl, n = ndimage.label(lab == t)
                if n <= 1:
                    continue
                keep = np.argmax(np.bincount(cl.ravel())[1:]) + 1
                for i in range(1, n + 1):
                    if i == keep:
                        continue
                    frag = cl == i
                    ring = ndimage.binary_dilation(frag) & ~frag
                    cand = [v for v in lab[ring] if v >= 0 and v != t]
                    if cand:
                        lab[frag] = Counter(cand).most_common(1)[0][0]
                        moved += 1
            if not moved:
                break
        return lab, seed_unit

    # --- tile layout, refined: too narrow for a pawn -> one tile fewer in that sea;
    # too wide (a fast lane east-west) -> one tile more
    alloc = largest_remainder([u["px"] for u in units], tc["count"])
    ref_side = math.sqrt(sum(u["px"] for u in units) / tc["count"])   # side of an average tile
    locked = set()
    extra = 0
    for rnd in range(tc["refine_rounds"] + 4):
        lab, seed_unit = relax(alloc)
        n_t = len(seed_unit)
        final = rnd >= tc["refine_rounds"]      # after the normal rounds: only fix pawn fit
        objs = ndimage.find_objects(lab + 1, max_label=n_t)
        changes = {}
        worst = defaultdict(float)
        for t in range(n_t):
            u = seed_unit[t]
            m = lab == t
            if objs[t] is None:
                continue
            fit = 2 * pole_of_inaccessibility(m)[2]
            width = objs[t][1].stop - objs[t][1].start
            normal = ref_side       # fixed reference, so adding tiles does not chase itself
            if fit < pawn_px and alloc[u] > 1:
                changes[u] = -1
                locked.add(u)
            elif (not final and width > tc["max_width_factor"] * normal
                  and u not in locked and changes.get(u, 0) >= 0):
                worst[u] = max(worst[u], width / (tc["max_width_factor"] * normal))
                changes[u] = max(1, int(math.ceil(alloc[u] * (worst[u] - 1) * 0.7)))
        if not changes:
            break
        for u, d in changes.items():
            alloc[u] += d
        say(f"  refine {rnd + 1}: " + ", ".join(
            f"{meta[names[units[u]['region']]]['name']} {'+' if d > 0 else ''}{d}" for u, d in changes.items()))
    tile_region = np.array([units[u]["region"] for u in seed_unit])

    # renumber tiles 1..n: west to east within bands, so numbers are easy to find
    pole = [pole_of_inaccessibility(lab == t) for t in range(n_t)]
    band = max(H / 6, 1)
    order = sorted(range(n_t), key=lambda t: (int(pole[t][0] // band), pole[t][1]))
    new_id = np.empty(n_t, int)
    new_id[order] = np.arange(1, n_t + 1)
    lab = np.where(lab >= 0, new_id[np.maximum(lab, 0)], 0)      # 0 = land / not playable
    tile_region = np.concatenate([[-1], tile_region[order]])     # index by tile id
    pole = [None] + [pole[t] for t in order]
    ids = range(1, n_t + 1)

    # --- neighbours
    adj = defaultdict(int)
    for a, b in ((lab[:, :-1], lab[:, 1:]), (lab[:-1, :], lab[1:, :])):
        m = (a > 0) & (b > 0) & (a != b)
        for x, y in zip(a[m], b[m]):
            adj[(min(x, y), max(x, y))] += 1
    edges = {k: "sea" for k in adj}
    wraps = []          # (left tile, right tile, row in mm)
    a, b = lab[:, 0], lab[:, -1]
    m = (a > 0) & (b > 0)
    runs = defaultdict(list)
    for r in np.flatnonzero(m):
        runs[(int(a[r]), int(b[r]))].append(r)
    for (x, y), rows in runs.items():
        if x == y or len(rows) < tc["min_wrap_edge_mm"] * ppm:
            continue        # too short a shared edge: no crossing here
        edges.setdefault((min(x, y), max(x, y)), "wrap")
        wraps.append({"left": x, "right": y, "rows": rows})
    # arrow height: the spot along the shared edge furthest from pawn circles and other arrows
    spots_mm = np.array([[(pole[t][1] + 0.5) / ppm, (pole[t][0] + 0.5) / ppm] for t in ids])
    near_edge = spots_mm[(spots_mm[:, 0] < 22) | (spots_mm[:, 0] > W / ppm - 22)]
    placed = []
    for wv in sorted(wraps, key=lambda w: len(w["rows"])):
        rows = np.array(wv.pop("rows"))
        cand = (rows + 0.5) / ppm
        inner = cand[(cand > cand.min() + 1.5) & (cand < cand.max() - 1.5)]
        cand = inner if len(inner) else cand
        obst = np.concatenate([near_edge[:, 1], placed]) if len(near_edge) or placed else np.array([1e9])
        clear = np.abs(cand[:, None] - obst[None, :]).min(1)
        wv["y_mm"] = round(float(cand[int(np.argmax(clear))]), 2)
        placed.append(wv["y_mm"])

    # --- passages
    nearest = ndimage.distance_transform_edt(lab == 0, return_distances=False, return_indices=True)
    passages = []
    for p in cfg["passages"]:
        if not p.get("enabled", True):
            continue
        ends = []
        for lon, lat in (p["a"], p["b"]):
            x, y = proj.forward(lon, lat)
            r = min(max(int(y * ppm), 0), H - 1)
            c = min(max(int(x * ppm), 0), W - 1)
            rr, cc = nearest[0][r, c], nearest[1][r, c]
            dmm = math.hypot(rr - r, cc - c) / ppm
            ends.append((int(lab[rr, cc]), dmm, (float(x), float(y))))
        (ta, da, pa), (tb, db, pb) = ends
        if max(da, db) > 3:
            say(f"passage '{p['name']}' skipped: one end is not in a drawn sea")
            continue
        if ta == tb:
            say(f"passage '{p['name']}' skipped: both ends are in tile {ta}")
            continue
        key = (min(ta, tb), max(ta, tb))
        natural = key in adj
        if not natural:
            edges[key] = p["kind"]
        path = [pa] + [tuple(float(v) for v in proj.forward(lo, la)) for lo, la in p.get("via", [])] + [pb]
        passages.append({"name": p["name"], "kind": p["kind"], "tiles": [ta, tb],
                         "already_connected": bool(natural), "a_mm": pa, "b_mm": pb,
                         "path_mm": [[round(x, 2), round(y, 2)] for x, y in path],
                         "drawn": p["kind"] == "canal" or not natural})

    # --- connectivity check
    nb = defaultdict(set)
    for (x, y) in edges:
        nb[x].add(y)
        nb[y].add(x)
    seen, q = {1}, deque([1])
    while q:
        t = q.popleft()
        for u in nb[t] - seen:
            seen.add(u)
            q.append(u)
    if len(seen) < n_t:
        lost = sorted(set(ids) - seen)
        say(f"WARNING: tiles not reachable from tile 1: {lost} - add a passage")

    # --- borders as smoothed polylines
    reg_of = tile_region[lab]
    segs = {"tile": [], "region": []}
    W1 = W + 1
    left_out = (lab == 0) & ~land          # water that belongs to no tile: also gets a border
    a, b = lab[:, :-1], lab[:, 1:]
    lo_a, lo_b = left_out[:, :-1], left_out[:, 1:]
    m = ((a > 0) & (b > 0) & (a != b)) | ((a > 0) & lo_b) | (lo_a & (b > 0))
    rr, cc = np.nonzero(m)
    kind = np.where(reg_of[:, :-1][m] != reg_of[:, 1:][m], "region", "tile")
    for r, c, k in zip(rr, cc, kind):
        segs[k].append((r * W1 + c + 1, (r + 1) * W1 + c + 1))
    a, b = lab[:-1, :], lab[1:, :]
    lo_a, lo_b = left_out[:-1, :], left_out[1:, :]
    m = ((a > 0) & (b > 0) & (a != b)) | ((a > 0) & lo_b) | (lo_a & (b > 0))
    rr, cc = np.nonzero(m)
    kind = np.where(reg_of[:-1, :][m] != reg_of[1:, :][m], "region", "tile")
    for r, c, k in zip(rr, cc, kind):
        segs[k].append(((r + 1) * W1 + c, (r + 1) * W1 + c + 1))
    borders = []
    for k, ss in segs.items():
        for line, closed in chain_segments(ss):
            v = np.array(line)
            pts = np.column_stack([v % W1, v // W1]).astype(float) / ppm
            if closed:
                pts = pts[:-1]
            pts = chaikin(pts, 3, closed)
            borders.append({"kind": k, "closed": bool(closed), "pts": np.round(pts, 2).tolist()})

    # --- tiles
    tiles = []
    for t in ids:
        r, c, d = pole[t]
        tiles.append({
            "id": int(t), "sea": meta[names[tile_region[t]]]["name"],
            "area_mm2": round(float((lab == t).sum()) / ppm ** 2, 1),
            "pawn_mm": [round((c + 0.5) / ppm, 2), round((r + 0.5) / ppm, 2)],
            "inscribed_diameter_mm": round(2 * d / ppm, 1),
            "neighbours": sorted(int(u) for u in nb[t]),
        })

    # --- sea names: free spot inside the own sea, clear of pawn circles, other names and edge arrows
    regions = place_labels(cfg, present, names, meta, tile_region, lab, reg_of, tiles, wraps, ppm, W, H)

    save_json(out / "tiles.json", {
        "board": {"width_mm": proj.width, "height_mm": proj.board_h, "map_height_mm": proj.map_h,
                  "panel_height_mm": proj.panel_h, "projection": proj.kind, "center_lon": proj.lon0,
                  "lat_north": proj.lat_n, "lat_south": proj.lat_s, "wraps_east_west": True,
                  "pawn_diameter_mm": tc["pawn_diameter_mm"]},
        "tiles": tiles, "seas": regions,
        "edges": [{"tiles": [int(x), int(y)], "kind": k} for (x, y), k in sorted(edges.items())],
        "wraps": wraps, "passages": passages})
    save_json(out / "borders.json", borders)
    np.save(out / "labels.npy", lab.astype(np.int16))

    # --- report
    areas = np.array([t["area_mm2"] for t in tiles])
    say(f"\n{n_t} tiles in {len(regions)} seas; tile area mean {areas.mean():.0f} mm2, "
        f"spread (CV) {areas.std() / areas.mean():.0%}, min {areas.min():.0f}, max {areas.max():.0f}")
    say("tiles per sea: " + ", ".join(f"{s['name']} {len(s['tiles'])}" for s in regions))
    pd = tc["pawn_diameter_mm"]
    tight = [t for t in tiles if t["inscribed_diameter_mm"] < pd]
    say(f"{len(tight)} tiles where a {pd} mm pawn does not fit inside"
        + (": " + ", ".join(f"{t['id']} {t['sea']} ({t['inscribed_diameter_mm']} mm)" for t in tight) if tight else ""))
    for p in passages:
        say(f"passage {p['name']}: tiles {p['tiles']}" + (" (already touching by sea)" if p["already_connected"] else ""))
    (out / "report.txt").write_text("\n".join(log) + "\n")

    # --- preview image
    from PIL import Image, ImageDraw
    img = np.zeros((H, W, 3), np.uint8)
    img[:] = (214, 200, 170)
    pal = {}
    for i, r in enumerate(present):
        h = (i * 0.618) % 1.0
        pal[r] = np.array(colorsys.hls_to_rgb(h, 0.62, 0.45)) * 255
    for t in ids:
        shade = 0.88 + 0.12 * ((t * 7) % 5) / 4
        img[lab == t] = (pal[tile_region[t]] * shade).astype(np.uint8)
    im = Image.fromarray(img)
    dr = ImageDraw.Draw(im)
    for bd in borders:
        pts = [(x * ppm, y * ppm) for x, y in bd["pts"]]
        dr.line(pts + (pts[:1] if bd["closed"] else []), fill=(30, 30, 40),
                width=3 if bd["kind"] == "region" else 1)
    for t in tiles:
        x, y = t["pawn_mm"][0] * ppm, t["pawn_mm"][1] * ppm
        dr.text((x, y), str(t["id"]), fill=(0, 0, 0), anchor="mm")
    im.save(out / "preview.png")
    print(f"\nwritten to {out}")


def font_file(family, italic=True):
    import subprocess
    pat = family + (":italic" if italic else "")
    return subprocess.run(["fc-match", "-f", "%{file}", pat], capture_output=True, text=True).stdout


def place_labels(cfg, present, names, meta, tile_region, lab, reg_of, tiles, wraps, ppm, W, H):
    """Choose a position for each sea name. Sizes and positions in board mm."""
    from PIL import ImageFont
    c = cfg["compose"]
    font = ImageFont.truetype(font_file(c["font"]), 100)
    pawn_r = cfg["tiles"]["pawn_diameter_mm"] / 2 + 0.8
    circles = np.array([t["pawn_mm"] for t in tiles])
    boxes = []          # placed labels and arrows: (cx, cy, w, h)
    for wv in wraps:    # edge arrows with their numbers
        boxes.append((6.0, wv["y_mm"], 12.0, 6.0))
        boxes.append((W / ppm - 6.0, wv["y_mm"], 12.0, 6.0))
    step = 1.5
    out = []
    order = sorted(present, key=lambda r: (meta[names[r]]["class"] != "ocean", -(reg_of == r).sum()))
    for r in order:
        m = meta[names[r]]
        ocean = m["class"] == "ocean"
        size = c["ocean_label_mm"] if ocean else c["sea_label_mm"]
        spacing = 0.2 * size if ocean else 0.05 * size
        text = (m["name_nl"] if c["language"] == "nl" else m["name"])
        text = text.upper() if ocean else text
        bw = font.getlength(text) / 100 * size + spacing * (len(text) - 1) + 1.0
        bh = size * 1.05
        mask = reg_of == r
        ii = np.pad(mask.astype(np.int32), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
        rows, cols = np.nonzero(mask)
        ys = np.arange(rows.min() / ppm, (rows.max() + 1) / ppm, step)
        xs = np.arange(cols.min() / ppm, (cols.max() + 1) / ppm, step)
        gx, gy = np.meshgrid(xs, ys)
        gx, gy = gx.ravel(), gy.ravel()
        x0 = np.clip(((gx - bw / 2) * ppm).astype(int), 0, W)
        x1 = np.clip(((gx + bw / 2) * ppm).astype(int), 0, W)
        y0 = np.clip(((gy - bh / 2) * ppm).astype(int), 0, H)
        y1 = np.clip(((gy + bh / 2) * ppm).astype(int), 0, H)
        full = (bw * ppm) * (bh * ppm)
        inside = (ii[y1, x1] - ii[y0, x1] - ii[y1, x0] + ii[y0, x0]) / full
        ok = (gx - bw / 2 > 0) & (gx + bw / 2 < W / ppm) & (gy - bh / 2 > 0) & (gy + bh / 2 < H / ppm)
        # clearance to pawn circles
        dx = np.maximum(np.abs(circles[:, 0][None] - gx[:, None]) - bw / 2, 0)
        dy = np.maximum(np.abs(circles[:, 1][None] - gy[:, None]) - bh / 2, 0)
        clear = (np.hypot(dx, dy) - pawn_r).min(1)
        if boxes:
            bx = np.array(boxes)
            gapx = np.abs(bx[:, 0][None] - gx[:, None]) - (bx[:, 2][None] + bw) / 2
            gapy = np.abs(bx[:, 1][None] - gy[:, None]) - (bx[:, 3][None] + bh) / 2
            clear = np.minimum(clear, np.maximum(gapx, gapy).min(1))
        pr, pc, _ = pole_of_inaccessibility(mask)
        dist_pole = np.hypot(gx - pc / ppm, gy - pr / ppm)
        score = (np.minimum(clear, 3.0) * 10            # first: stay clear (up to 3 mm)
                 + inside * 20                            # then: stay inside the own sea
                 - dist_pole * 0.02)                      # then: near the middle of the sea
        score[~ok] = -1e9
        best = int(np.argmax(score))
        out.append({**m, "tiles": [int(t) for t in np.flatnonzero(tile_region == r)],
                    "label_mm": [round(float(gx[best]), 2), round(float(gy[best]), 2)],
                    "label_size_mm": size, "label_spacing_mm": round(spacing, 2),
                    "label_clear_mm": round(float(clear[best]), 1),
                    "label_inside": round(float(inside[best]), 2)})
        boxes.append((gx[best], gy[best], bw, bh))
    out.sort(key=lambda s: -len(s["tiles"]))
    return out


if __name__ == "__main__":
    main()
