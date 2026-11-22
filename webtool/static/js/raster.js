// Raster algorithms on the tile label grid.
// The grid is an Int16Array (row-major, W x H). 0 = no tile (land or unplayable water).
// Same idea as ../src/make_tiles.py: tiles are geodesic Voronoi cells through the water,
// relaxed with Lloyd steps plus area balancing.

// ---------------------------------------------------------------- binary heap
export class Heap {
  constructor(cap = 4096) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
    this.lastKey = 0;
  }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    const K = this.k, V = this.v;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v;
    const top = V[0];
    this.lastKey = K[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], val = V[n];
      let i = 0;
      for (;;) {
        let l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        if (r < n && K[r] < K[l]) l = r;
        if (K[l] >= key) break;
        K[i] = K[l]; V[i] = V[l]; i = l;
      }
      K[i] = key; V[i] = val;
    }
    return top;
  }
}

const NB8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

// ---------------------------------------------------------------- geodesic voronoi
// Multi-source Dijkstra on a local grid (cw x ch). allowed: Uint8Array, cost: Float32Array.
// seeds: [{i, w, l}] local index, start cost, label. No corner cutting past blocked pixels.
export function geoVoronoi(cw, ch, allowed, cost, seeds) {
  const N = cw * ch;
  const dist = new Float64Array(N).fill(Infinity);
  const lab = new Int32Array(N).fill(-1);
  const heap = new Heap(Math.max(1024, N >> 3));
  for (const s of seeds) {
    if (s.i < 0 || !allowed[s.i]) continue;
    if (s.w < dist[s.i]) { dist[s.i] = s.w; lab[s.i] = s.l; heap.push(s.w, s.i); }
  }
  while (heap.n > 0) {
    const p = heap.pop();
    const d = heap.lastKey;
    if (d > dist[p]) continue;
    const r = (p / cw) | 0, c = p - r * cw, l = lab[p], cp = cost[p];
    for (let k = 0; k < 8; k++) {
      const dr = NB8[k][0], dc = NB8[k][1];
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= ch || cc < 0 || cc >= cw) continue;
      const q = rr * cw + cc;
      if (!allowed[q]) continue;
      let step = 1;
      if (dr !== 0 && dc !== 0) {
        if (!allowed[r * cw + cc] || !allowed[rr * cw + c]) continue;
        step = 1.41421356;
      }
      const nd = d + step * 0.5 * (cp + cost[q]);
      if (nd < dist[q]) { dist[q] = nd; lab[q] = l; heap.push(nd, q); }
    }
  }
  return { lab, dist };
}

// Grow one region from a start pixel until `target` pixels are settled.
export function growRegion(cw, ch, allowed, cost, start, target) {
  const N = cw * ch;
  const dist = new Float64Array(N).fill(Infinity);
  const done = new Uint8Array(N);
  const heap = new Heap(4096);
  if (start < 0 || !allowed[start]) return { mask: done, count: 0 };
  dist[start] = 0; heap.push(0, start);
  let count = 0;
  while (heap.n > 0 && count < target) {
    const p = heap.pop();
    const d = heap.lastKey;
    if (d > dist[p] || done[p]) continue;
    done[p] = 1; count++;
    const r = (p / cw) | 0, c = p - r * cw;
    for (let k = 0; k < 8; k++) {
      const dr = NB8[k][0], dc = NB8[k][1];
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= ch || cc < 0 || cc >= cw) continue;
      const q = rr * cw + cc;
      if (!allowed[q] || done[q]) continue;
      let step = 1;
      if (dr !== 0 && dc !== 0) {
        if (!allowed[r * cw + cc] || !allowed[rr * cw + c]) continue;
        step = 1.41421356;
      }
      const nd = d + step * 0.5 * (cost[p] + cost[q]);
      if (nd < dist[q]) { dist[q] = nd; heap.push(nd, q); }
    }
  }
  return { mask: done, count };
}

// ---------------------------------------------------------------- distance transform
const BIG = 1e20;
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -BIG; z[1] = BIG;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = BIG;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Euclidean distance from each inside pixel (mask=1) to the nearest outside pixel.
// Pixels beyond the grid count as outside.
export function edt(mask, w, h) {
  const n = Math.max(w, h) + 2;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const g = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    f[0] = 0;
    for (let y = 0; y < h; y++) f[y + 1] = mask[y * w + x] ? BIG : 0;
    f[h + 1] = 0;
    edt1d(f, h + 2, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y + 1];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    f[0] = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) f[x + 1] = g[row + x];
    f[w + 1] = 0;
    edt1d(f, w + 2, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = Math.sqrt(d[x + 1]);
  }
  return out;
}

// ---------------------------------------------------------------- whole-board analysis
// Areas, bounding boxes, neighbour pairs, inscribed circles (pawn spots), fragments.
export function analyse(lab, W, H, maxId) {
  const M = maxId + 1;
  const area = new Int32Array(M);
  const x0 = new Int32Array(M).fill(W), y0 = new Int32Array(M).fill(H);
  const x1 = new Int32Array(M).fill(-1), y1 = new Int32Array(M).fill(-1);
  const N = W * H;
  const inner = new Uint8Array(N);
  const pairs = new Map();
  const addPair = (a, b) => {
    const key = a < b ? a * 65536 + b : b * 65536 + a;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  };
  for (let r = 0; r < H; r++) {
    const row = r * W;
    for (let c = 0; c < W; c++) {
      const i = row + c, t = lab[i];
      if (t <= 0) continue;
      area[t]++;
      if (c < x0[t]) x0[t] = c;
      if (c > x1[t]) x1[t] = c;
      if (r < y0[t]) y0[t] = r;
      if (r > y1[t]) y1[t] = r;
      if (c > 0 && c < W - 1 && r > 0 && r < H - 1 &&
          lab[i - 1] === t && lab[i + 1] === t && lab[i - W] === t && lab[i + W] === t) inner[i] = 1;
      if (c < W - 1) { const u = lab[i + 1]; if (u > 0 && u !== t) addPair(t, u); }
      if (r < H - 1) { const u = lab[i + W]; if (u > 0 && u !== t) addPair(t, u); }
    }
  }
  const dt = edt(inner, W, H);
  const best = new Float32Array(M), pole = new Int32Array(M).fill(-1);
  for (let i = 0; i < N; i++) {
    const t = lab[i];
    if (t <= 0) continue;
    if (pole[t] < 0 || dt[i] > best[t]) { best[t] = dt[i]; pole[t] = i; }
  }
  // fragments: 4-connected pieces per tile (union-find)
  const parent = new Int32Array(N);
  const find = (a) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  for (let i = 0; i < N; i++) parent[i] = i;
  for (let r = 0; r < H; r++) {
    const row = r * W;
    for (let c = 0; c < W; c++) {
      const i = row + c, t = lab[i];
      if (t <= 0) continue;
      if (c > 0 && lab[i - 1] === t) { const a = find(i), b = find(i - 1); if (a !== b) parent[a] = b; }
      if (r > 0 && lab[i - W] === t) { const a = find(i), b = find(i - W); if (a !== b) parent[a] = b; }
    }
  }
  const pieces = new Int32Array(M);
  for (let i = 0; i < N; i++) if (lab[i] > 0 && parent[i] === i) pieces[lab[i]]++;
  return { area, x0, y0, x1, y1, pairs, inscribedPx: best, pole, pieces, maxId };
}

// East-west wrap connections: tiles meeting at the left and right map edge.
export function wraps(lab, W, H, minRunPx) {
  const runs = new Map();
  for (let r = 0; r < H; r++) {
    const a = lab[r * W], b = lab[r * W + W - 1];
    if (a > 0 && b > 0 && a !== b) {
      const key = a * 65536 + b;
      if (!runs.has(key)) runs.set(key, []);
      runs.get(key).push(r);
    }
  }
  const out = [];
  for (const [key, rows] of runs) {
    if (rows.length < minRunPx) continue;
    out.push({ left: Math.floor(key / 65536), right: key % 65536, row: rows[rows.length >> 1] });
  }
  return out;
}

// ---------------------------------------------------------------- noise
export function makeNoise(seed, cellPx, octaves = 3) {
  const s = (seed | 0) * 0x9e3779b1;
  const hash = (ix, iy, o) => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(o + 1, 1274126177) ^ s;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h & 0xffff) / 32767.5 - 1;
  };
  return (x, y) => {
    let tot = 0, amp = 1, norm = 0, cell = Math.max(cellPx, 2);
    for (let o = 0; o < octaves; o++) {
      const fx = x / cell, fy = y / cell;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = hash(ix, iy, o), b = hash(ix + 1, iy, o), c = hash(ix, iy + 1, o), d = hash(ix + 1, iy + 1, o);
      tot += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
      norm += amp; amp *= 0.5; cell = Math.max(cell / 2, 2);
    }
    return Math.max(-1, Math.min(1, 1.6 * tot / norm));
  };
}

// ---------------------------------------------------------------- local helpers
function bboxOf(lab, W, H, look) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let r = 0; r < H; r++) {
    const row = r * W;
    for (let c = 0; c < W; c++) {
      if (look[lab[row + c]]) {
        if (c < x0) x0 = c;
        if (c > x1) x1 = c;
        if (r < y0) y0 = r;
        if (r > y1) y1 = r;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

function nearestAllowed(allowed, cw, ch, c, r) {
  if (c >= 0 && c < cw && r >= 0 && r < ch && allowed[r * cw + c]) return r * cw + c;
  let best = -1, bd = Infinity;
  for (let i = 0; i < cw * ch; i++) {
    if (!allowed[i]) continue;
    const rr = (i / cw) | 0, cc = i - rr * cw;
    const d = (rr - r) * (rr - r) + (cc - c) * (cc - c);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Merge stray pieces of labels (local grid) into the neighbouring label they touch most.
function fixFragments(lab, cw, ch, n) {
  for (let round = 0; round < 6; round++) {
    let moved = 0;
    const comp = new Int32Array(cw * ch).fill(-1);
    const compLab = [], compSize = [], compPix = [];
    for (let i = 0; i < cw * ch; i++) {
      if (lab[i] < 0 || comp[i] >= 0) continue;
      const id = compLab.length, l = lab[i];
      const stack = [i], pix = [];
      comp[i] = id;
      while (stack.length) {
        const p = stack.pop();
        pix.push(p);
        const r = (p / cw) | 0, c = p - r * cw;
        if (c > 0 && comp[p - 1] < 0 && lab[p - 1] === l) { comp[p - 1] = id; stack.push(p - 1); }
        if (c < cw - 1 && comp[p + 1] < 0 && lab[p + 1] === l) { comp[p + 1] = id; stack.push(p + 1); }
        if (r > 0 && comp[p - cw] < 0 && lab[p - cw] === l) { comp[p - cw] = id; stack.push(p - cw); }
        if (r < ch - 1 && comp[p + cw] < 0 && lab[p + cw] === l) { comp[p + cw] = id; stack.push(p + cw); }
      }
      compLab.push(l); compSize.push(pix.length); compPix.push(pix);
    }
    const biggest = new Int32Array(n).fill(-1);
    for (let k = 0; k < compLab.length; k++) {
      const l = compLab[k];
      if (biggest[l] < 0 || compSize[k] > compSize[biggest[l]]) biggest[l] = k;
    }
    for (let k = 0; k < compLab.length; k++) {
      if (biggest[compLab[k]] === k) continue;
      const counts = new Map();
      for (const p of compPix[k]) {
        const r = (p / cw) | 0, c = p - r * cw;
        for (const q of [c > 0 ? p - 1 : -1, c < cw - 1 ? p + 1 : -1, r > 0 ? p - cw : -1, r < ch - 1 ? p + cw : -1]) {
          if (q >= 0 && lab[q] >= 0 && lab[q] !== compLab[k]) counts.set(lab[q], (counts.get(lab[q]) || 0) + 1);
        }
      }
      if (!counts.size) continue;
      let bestL = -1, bc = -1;
      for (const [l, cnt] of counts) if (cnt > bc) { bc = cnt; bestL = l; }
      for (const p of compPix[k]) lab[p] = bestL;
      moved++;
    }
    if (!moved) break;
  }
}

// ---------------------------------------------------------------- regrow (move / split)
// Re-partition the union of the given tiles into the same number of cells.
// opts.seeds: Map id -> [c, r] (global px) start positions; opts.fixed: Set of ids whose
// seed does not move; opts.iterations; opts.costAt(c, r).
// Ids that do not have pixels yet (a new tile) must have a seed.
export function regrow(lab, W, H, ids, opts) {
  const look = new Uint8Array(32768);
  for (const id of ids) look[id] = 1;
  const bb = bboxOf(lab, W, H, look);
  if (!bb) return null;
  const [x0, y0, x1, y1] = bb;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, N = cw * ch;
  const n = ids.length;
  const kOf = new Map(ids.map((id, k) => [id, k]));
  const allowed = new Uint8Array(N), orig = new Int32Array(N).fill(-1), cost = new Float32Array(N);
  const cnt = new Float64Array(n), sr = new Float64Array(n), sc = new Float64Array(n);
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      const g = (r + y0) * W + (c + x0), t = lab[g];
      if (!look[t]) continue;
      const i = r * cw + c, k = kOf.get(t);
      allowed[i] = 1; orig[i] = k;
      cnt[k]++; sr[k] += r; sc[k] += c;
      cost[i] = opts.costAt ? opts.costAt(c + x0, r + y0) : 1;
    }
  }
  const total = cnt.reduce((a, b) => a + b, 0);
  const tgt = total / n;
  const rad = Math.sqrt(tgt / Math.PI);
  // starting seeds
  const seed = new Int32Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    const s = opts.seeds && opts.seeds.get(ids[k]);
    if (s) { seed[k] = nearestAllowed(allowed, cw, ch, s[0] - x0, s[1] - y0); continue; }
    if (cnt[k] > 0) {
      const cy = sr[k] / cnt[k], cx = sc[k] / cnt[k];
      let best = -1, bd = Infinity;
      for (let i = 0; i < N; i++) {
        if (orig[i] !== k) continue;
        const rr = (i / cw) | 0, cc = i - rr * cw;
        const d = (rr - cy) ** 2 + (cc - cx) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      seed[k] = best;
    }
  }
  const fixed = opts.fixed || new Set();
  const iters = Math.max(0, opts.iterations ?? 12);
  const weights = new Float64Array(n);
  let res = null;
  for (let it = 0; it <= iters; it++) {
    const seeds = [];
    for (let k = 0; k < n; k++) if (seed[k] >= 0) seeds.push({ i: seed[k], w: weights[k], l: k });
    res = geoVoronoi(cw, ch, allowed, cost, seeds);
    if (it === iters) break;
    const a = new Float64Array(n), ar = new Float64Array(n), ac = new Float64Array(n);
    for (let i = 0; i < N; i++) {
      const l = res.lab[i];
      if (l < 0) continue;
      const rr = (i / cw) | 0;
      a[l]++; ar[l] += rr; ac[l] += i - rr * cw;
    }
    const bestD = new Float64Array(n).fill(Infinity), bestI = new Int32Array(n).fill(-1);
    for (let i = 0; i < N; i++) {
      const l = res.lab[i];
      if (l < 0 || fixed.has(ids[l])) continue;
      const rr = (i / cw) | 0, cc = i - rr * cw;
      const d = (rr - ar[l] / a[l]) ** 2 + (cc - ac[l] / a[l]) ** 2;
      if (d < bestD[l]) { bestD[l] = d; bestI[l] = i; }
    }
    let bigK = 0;
    for (let k = 1; k < n; k++) if (a[k] > a[bigK]) bigK = k;
    for (let k = 0; k < n; k++) {
      if (fixed.has(ids[k])) continue;
      if (a[k] === 0) {                // lost its cell: restart inside the biggest one
        const pix = [];
        for (let i = 0; i < N; i++) if (res.lab[i] === bigK) pix.push(i);
        if (pix.length) seed[k] = pix[(Math.random() * pix.length) | 0];
        weights[k] = 0;
        continue;
      }
      if (bestI[k] >= 0) seed[k] = bestI[k];
    }
    for (let k = 0; k < n; k++) weights[k] += 0.6 * (a[k] / tgt - 1) * rad;
    let mn = Infinity;
    for (let k = 0; k < n; k++) mn = Math.min(mn, weights[k]);
    for (let k = 0; k < n; k++) weights[k] = Math.min(weights[k] - mn, 0.8 * rad);
  }
  const out = res.lab;
  for (let i = 0; i < N; i++) if (allowed[i] && out[i] < 0) out[i] = orig[i];   // unreachable bits keep their tile
  fixFragments(out, cw, ch, n);
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      const i = r * cw + c;
      if (allowed[i]) lab[(r + y0) * W + (c + x0)] = ids[out[i]];
    }
  }
  return bb;
}

// Grow a new tile into empty water (lab === 0 and water) from (c, r).
export function growNewTile(lab, water, W, H, c, r, targetPx, id, costAt) {
  const R = Math.ceil(Math.sqrt(targetPx / Math.PI) * 3) + 4;
  const x0 = Math.max(0, c - R), x1 = Math.min(W - 1, c + R);
  const y0 = Math.max(0, r - R), y1 = Math.min(H - 1, r + R);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const allowed = new Uint8Array(cw * ch), cost = new Float32Array(cw * ch);
  for (let rr = 0; rr < ch; rr++) {
    for (let cc = 0; cc < cw; cc++) {
      const g = (rr + y0) * W + (cc + x0);
      if (water[g] && lab[g] === 0) {
        allowed[rr * cw + cc] = 1;
        cost[rr * cw + cc] = costAt ? costAt(cc + x0, rr + y0) : 1;
      }
    }
  }
  const { mask, count } = growRegion(cw, ch, allowed, cost, (r - y0) * cw + (c - x0), targetPx);
  for (let rr = 0; rr < ch; rr++) {
    for (let cc = 0; cc < cw; cc++) if (mask[rr * cw + cc]) lab[(rr + y0) * W + (cc + x0)] = id;
  }
  return count;
}

// Pieces of every tile that are smaller than its biggest piece go to the neighbour they touch most.
export function cleanupFragments(lab, W, H, maxId) {
  const ids = [];
  for (let t = 1; t <= maxId; t++) ids.push(t);
  const N = W * H;
  const local = new Int32Array(N);
  for (let i = 0; i < N; i++) local[i] = lab[i] > 0 ? lab[i] : -1;
  fixFragments(local, W, H, maxId + 1);
  let changed = 0;
  for (let i = 0; i < N; i++) {
    const v = local[i] < 0 ? 0 : local[i];
    if (v !== lab[i]) { lab[i] = v; changed++; }
  }
  return changed;
}
