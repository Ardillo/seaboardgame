// The editable design: label raster + metadata (tiles, seas, passages, fields), with undo.
// Coordinates: tiles, pawn spots, sea labels and passages use mm on the MAP area (like the
// pipeline's tiles.json); fields use mm on the WHOLE board (frame included).
import * as R from "./raster.js";
import { makeProjection } from "./projection.js";

const META_KEYS = ["tiles", "seas", "passages", "fields", "look", "arrows"];

export class Design {
  constructor(meta, labels, water) {
    this.meta = meta;
    this.lab = labels;
    this.water = water;
    this.W = meta.raster.W;
    this.H = meta.raster.H;
    this.ppm = meta.raster.ppm;
    this.proj = makeProjection(meta.board);
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.version = 0;
    this.analysis = null;
    this.analysisVersion = -1;
    this.labVersion = 0;        // counts pixel changes only
    this.rasterInfo = null;
    this.borders = [];
    this.pendingAffected = new Set();
    this.listeners = [];
    this.noiseCfg = null;
    meta.fields = meta.fields || [];
    meta.passages = meta.passages || [];
    meta.arrows = meta.arrows || {};        // "left-right" tile ids -> {y_mm, hidden, closed}
    this.reindex();
  }

  // ------------------------------------------------------------ basics
  on(fn) { this.listeners.push(fn); }
  emit(kind, info) { for (const fn of this.listeners) fn(kind, info); }
  get board() { return this.meta.board; }
  get frame() { return this.meta.board.frame || { top: 0, right: 0, bottom: 0, left: 0 }; }
  reindex() {
    this.tileMap = new Map(this.meta.tiles.map((t) => [t.id, t]));
    this.seaMap = new Map(this.meta.seas.map((s, i) => [s.name, { ...s, index: i, ref: s }]));
  }
  tile(id) { return this.tileMap.get(id); }
  sea(name) { const s = this.seaMap.get(name); return s ? s.ref : null; }
  seaIndex(name) { const s = this.seaMap.get(name); return s ? s.index : -1; }
  maxId() { let m = 0; for (const t of this.meta.tiles) m = Math.max(m, t.id); return m; }
  idAt(c, r) { return c >= 0 && r >= 0 && c < this.W && r < this.H ? this.lab[r * this.W + c] : 0; }
  mapToPx(mx, my) { return [Math.floor(mx * this.ppm), Math.floor(my * this.ppm)]; }
  pxToMap(c, r) { return [(c + 0.5) / this.ppm, (r + 0.5) / this.ppm]; }
  boardToMap(x, y) { return [x - this.frame.left, y - this.frame.top]; }
  mapToBoard(x, y) { return [x + this.frame.left, y + this.frame.top]; }

  setNoise(tilesCfg) {
    const key = JSON.stringify([tilesCfg.random_seed, tilesCfg.noise_scale_mm, tilesCfg.border_noise]);
    if (this.noiseKey === key) return;
    this.noiseKey = key;
    const n = R.makeNoise(tilesCfg.random_seed ?? 7, (tilesCfg.noise_scale_mm ?? 40) * this.ppm);
    const amp = tilesCfg.border_noise ?? 0.35;
    this.costAt = (c, r) => Math.max(0.2, 1 + amp * n(c, r));
  }

  // ------------------------------------------------------------ transactions / undo
  snapshotMeta() { const o = {}; for (const k of META_KEYS) o[k] = this.meta[k]; return JSON.stringify(o); }
  restoreMeta(s) { const o = JSON.parse(s); for (const k of META_KEYS) this.meta[k] = o[k]; this.reindex(); }

  begin(label, pixels = true) {
    this.tx = { label, meta: this.snapshotMeta(), lab: pixels ? this.lab.slice() : null };
  }

  commit(info = {}) {
    const tx = this.tx;
    if (!tx) return;
    this.tx = null;
    let idx = null, before = null, after = null;
    const affected = new Set();
    if (tx.lab) {
      const ii = [], bb = [], aa = [];
      const L = this.lab, S = tx.lab;
      for (let i = 0; i < L.length; i++) {
        if (L[i] !== S[i]) { ii.push(i); bb.push(S[i]); aa.push(L[i]); affected.add(S[i]); affected.add(L[i]); }
      }
      affected.delete(0);
      if (ii.length) { idx = Int32Array.from(ii); before = Int16Array.from(bb); after = Int16Array.from(aa); }
      // tiles painted away completely disappear
      if (affected.size) {
        const area = new Map([...affected].map((t) => [t, 0]));
        for (let i = 0; i < L.length; i++) { const t = L[i]; if (area.has(t)) area.set(t, area.get(t) + 1); }
        const gone = [...area].filter(([, a]) => a === 0).map(([t]) => t);
        if (gone.length) {
          this.meta.tiles = this.meta.tiles.filter((t) => !gone.includes(t.id));
          this.reindex();
        }
      }
    }
    if (tx.lab) this.pruneArrows();
    const metaAfter = this.snapshotMeta();
    if (!idx && metaAfter === tx.meta) return;
    this.undoStack.push({ label: tx.label, idx, before, after, metaBefore: tx.meta, metaAfter, affected: [...affected] });
    if (this.undoStack.length > 150) this.undoStack.shift();
    this.redoStack = [];
    this.changed(affected, info.region);
  }

  cancel() {
    if (!this.tx) return;
    if (!this.tx.lab && this.snapshotMeta() === this.tx.meta) {     // a plain click: nothing to take back
      this.tx = null;
      return;
    }
    if (this.tx.lab) { this.lab.set(this.tx.lab); this.labVersion++; }
    this.restoreMeta(this.tx.meta);
    this.tx = null;
    this.changed(new Set());
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    if (e.idx) for (let k = 0; k < e.idx.length; k++) this.lab[e.idx[k]] = e.before[k];
    this.restoreMeta(e.metaBefore);
    this.redoStack.push(e);
    this.changed(new Set(e.affected));
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    if (e.idx) for (let k = 0; k < e.idx.length; k++) this.lab[e.idx[k]] = e.after[k];
    this.restoreMeta(e.metaAfter);
    this.undoStack.push(e);
    this.changed(new Set(e.affected));
    return e.label;
  }

  changed(affected, region) {
    for (const t of affected || []) this.pendingAffected.add(t);
    if (affected?.size) this.labVersion++;
    this.dirty = true;
    this.version++;
    this.emit("changed", { affected, region });
  }

  touchMeta() { this.dirty = true; this.version++; this.emit("meta"); }

  // ------------------------------------------------------------ analysis
  ensureAnalysis(cfg) {
    if (this.analysisVersion === this.version && this.analysis) return this.analysis;
    const maxId = Math.max(this.maxId(), this.labMax());
    if (this.rasterInfo?.at !== this.labVersion || this.rasterInfo.maxId !== maxId) {
      this.rasterInfo = { at: this.labVersion, maxId, data: R.analyse(this.lab, this.W, this.H, maxId) };
    }
    const a = { ...this.rasterInfo.data };
    this.analysis = a;
    this.analysisVersion = this.version;
    // pawn spots follow the shape for tiles whose pixels changed (unless placed by hand)
    let moved = false;
    for (const id of this.pendingAffected) {
      const t = this.tile(id);
      if (!t || a.pole[id] < 0) continue;
      const [pc, pr] = t.pawn_mm ? this.mapToPx(t.pawn_mm[0], t.pawn_mm[1]) : [-1, -1];
      if (!t.pawn_manual || this.idAt(pc, pr) !== id) {
        const p = a.pole[id];
        const xy = this.pxToMap(p % this.W, Math.floor(p / this.W));
        t.pawn_mm = xy.map(R.pyRound2);
        t.pawn_manual = false;
        moved = true;
      }
    }
    this.pendingAffected.clear();
    for (const t of this.meta.tiles) {      // tiles that never had a spot
      if (!t.pawn_mm && a.pole[t.id] >= 0) {
        const p = a.pole[t.id];
        t.pawn_mm = this.pxToMap(p % this.W, Math.floor(p / this.W)).map(R.pyRound2);
        moved = true;
      }
    }
    a.wraps = R.wraps(this.lab, this.W, this.H, this.ppm, this.meta.tiles.filter((t) => t.pawn_mm).map((t) => t.pawn_mm),
      cfg?.tiles?.min_wrap_edge_mm ?? 4, this.meta.arrows, this.meta.look?.arrow_size ?? 1);
    a.graph = this.buildGraph(a);
    const seas = this.meta.tiles.map((t) => `${t.id}:${this.seaIndex(t.sea)}`).join();
    const key = `${this.labVersion}|${seas}`;
    if (key !== this.bordersKey) { this.bordersKey = key; this.traceBorders(); }
    if (moved) this.emit("pawns");
    return a;
  }

  // arrow edits of tiles that are gone (their number may be given to a new tile)
  pruneArrows() {
    for (const key of Object.keys(this.meta.arrows)) {
      if (!key.split("-").every((id) => this.tile(+id))) delete this.meta.arrows[key];
    }
  }

  editArrow(label, key, change) {
    this.edit(label, (m) => {
      const next = { ...m.arrows[key], ...change };
      for (const k of Object.keys(next)) if (next[k] === false || next[k] === undefined) delete next[k];
      const all = { ...m.arrows };
      if (Object.keys(next).length) all[key] = next; else delete all[key];
      m.arrows = all;
    });
  }

  arrowSpotFor(wrap, want) { return R.arrowSpot(wrap.rows, this.ppm, this.H, want, this.meta.look.arrow_size); }
  arrowSpotsFor(wrap) { return R.arrowSpots(wrap.rows, this.ppm, this.H, this.meta.look.arrow_size).map(R.pyRound2); }

  traceBorders() {
    const seaOf = new Int16Array(this.maxId() + 1).fill(-1);
    for (const t of this.meta.tiles) seaOf[t.id] = this.seaIndex(t.sea);
    this.borders = R.borders(this.lab, this.water, this.W, this.H, this.ppm, seaOf);
  }

  labMax() { let m = 0; const L = this.lab; for (let i = 0; i < L.length; i++) if (L[i] > m) m = L[i]; return m; }

  // passage end -> nearest tile within 3 mm
  tileNear(mx, my, maxMm = 3) {
    const [c, r] = this.mapToPx(mx, my);
    const rad = Math.ceil(maxMm * this.ppm);
    let best = 0, bd = Infinity;
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        const d = dr * dr + dc * dc;
        if (d >= bd || d > rad * rad) continue;
        const t = this.idAt(c + dc, r + dr);
        if (t > 0) { bd = d; best = t; }
      }
    }
    return best;
  }

  resolvePassages(a) {
    return this.meta.passages.map((p) => {
      if (!p.enabled) return { p, status: "off" };
      const ta = this.tileNear(...p.a_mm), tb = this.tileNear(...p.b_mm);
      if (!ta || !tb) return { p, ta, tb, status: "an end is not in a tile" };
      if (ta === tb) return { p, ta, tb, status: `both ends in tile ${ta}` };
      const key = ta < tb ? ta * 65536 + tb : tb * 65536 + ta;
      const natural = a.pairs.has(key);
      return { p, ta, tb, natural, status: "ok", drawn: p.kind !== "strait" || !natural };
    });
  }

  buildGraph(a) {
    const nb = new Map(this.meta.tiles.map((t) => [t.id, new Map()]));
    const add = (x, y, kind) => {
      if (!nb.has(x) || !nb.has(y)) return;
      if (!nb.get(x).has(y)) nb.get(x).set(y, kind);
      if (!nb.get(y).has(x)) nb.get(y).set(x, kind);
    };
    for (const key of a.pairs.keys()) add(Math.floor(key / 65536), key % 65536, "sea");
    for (const w of a.wraps) if (!w.closed) add(w.left, w.right, "wrap");
    a.passageInfo = this.resolvePassages(a);
    for (const pi of a.passageInfo) if (pi.status === "ok") add(pi.ta, pi.tb, pi.p.kind);
    // reachability from the lowest tile id
    const ids = [...nb.keys()].sort((x, y) => x - y);
    const seen = new Set();
    if (ids.length) {
      const q = [ids[0]];
      seen.add(ids[0]);
      while (q.length) {
        const t = q.pop();
        for (const u of nb.get(t).keys()) if (!seen.has(u)) { seen.add(u); q.push(u); }
      }
    }
    a.unreachable = ids.filter((t) => !seen.has(t));
    return nb;
  }

  // ------------------------------------------------------------ tile operations
  neighboursOf(id, sameSea) {
    const a = this.analysis;
    const out = [];
    if (!a) return out;
    const t = this.tile(id);
    for (const key of a.pairs.keys()) {
      const x = Math.floor(key / 65536), y = key % 65536;
      const o = x === id ? y : y === id ? x : 0;
      if (!o) continue;
      const ot = this.tile(o);
      if (!ot || ot.pinned) continue;
      if (sameSea && t && ot.sea !== t.sea) continue;
      out.push(o);
    }
    return out;
  }

  moveTile(id, c, r, opts, cfg) {
    this.ensureAnalysis(cfg);
    const ids = [id, ...(opts.relaxNeighbours ? this.neighboursOf(id, opts.scope !== "all") : [])];
    this.begin(`move tile ${id}`);
    const seeds = new Map([[id, [c, r]]]);
    const bb = R.regrow(this.lab, this.W, this.H, ids, {
      seeds, fixed: new Set([id]), iterations: opts.iterations, costAt: this.costAt,
    });
    const t = this.tile(id);
    if (t) t.pawn_manual = false;
    this.commit({ region: bb });
    return ids;
  }

  splitAt(c, r, opts, cfg) {
    const id = this.idAt(c, r);
    if (!id) return null;
    this.ensureAnalysis(cfg);
    const newId = Math.max(this.maxId(), this.labMax()) + 1;
    const extra = opts.relaxNeighbours ? this.neighboursOf(id, true) : [];
    const ids = [id, ...extra, newId];
    // the old tile restarts at its pixel farthest from the click
    const a = this.analysis;
    let far = null, fd = -1;
    for (let rr = a.y0[id]; rr <= a.y1[id]; rr += 2) {
      for (let cc = a.x0[id]; cc <= a.x1[id]; cc += 2) {
        if (this.lab[rr * this.W + cc] !== id) continue;
        const d = (rr - r) ** 2 + (cc - c) ** 2;
        if (d > fd) { fd = d; far = [cc, rr]; }
      }
    }
    this.begin(`split tile ${id}`);
    const old = this.tile(id);
    this.meta.tiles.push({ id: newId, sea: old ? old.sea : "", pawn_mm: null, pawn_manual: false, pinned: false, note: "" });
    this.reindex();
    const seeds = new Map([[newId, [c, r]]]);
    if (far) seeds.set(id, far);
    const bb = R.regrow(this.lab, this.W, this.H, ids, { seeds, iterations: opts.iterations, costAt: this.costAt });
    if (old) old.pawn_manual = false;
    this.commit({ region: bb });
    return newId;
  }

  growAt(c, r, opts, cfg) {
    if (!this.water[r * this.W + c] || this.idAt(c, r)) return null;
    const a = this.ensureAnalysis(cfg);
    const newId = Math.max(this.maxId(), this.labMax()) + 1;
    let targetPx = (opts.newTileArea || 0) * this.ppm * this.ppm;
    if (!targetPx) {
      let s = 0, n = 0;
      for (const t of this.meta.tiles) if (a.area[t.id]) { s += a.area[t.id]; n++; }
      targetPx = n ? s / n : 1500 * this.ppm * this.ppm;
    }
    this.begin(`new tile ${newId}`);
    const count = R.growNewTile(this.lab, this.water, this.W, this.H, c, r, Math.round(targetPx), newId, this.costAt);
    // sea: the sea of the tile it touches most, else the first sea
    const touch = new Map();
    const rad = Math.ceil(Math.sqrt(targetPx) * 1.5);
    for (let rr = Math.max(0, r - rad); rr < Math.min(this.H, r + rad); rr += 2) {
      for (let cc = Math.max(0, c - rad); cc < Math.min(this.W, c + rad); cc += 2) {
        const t = this.lab[rr * this.W + cc];
        if (t > 0 && t !== newId && this.tile(t)) touch.set(this.tile(t).sea, (touch.get(this.tile(t).sea) || 0) + 1);
      }
    }
    let sea = this.meta.seas[0]?.name || "";
    let bc = -1;
    for (const [s, n] of touch) if (n > bc) { bc = n; sea = s; }
    this.meta.tiles.push({ id: newId, sea: opts.sea || sea, pawn_mm: null, pawn_manual: false, pinned: false, note: "" });
    this.reindex();
    this.commit();
    return { id: newId, count, targetPx };
  }

  merge(ids) {
    ids = [...new Set(ids)].filter((id) => this.tile(id));
    if (ids.length < 2) return null;
    const keep = ids[0];
    const look = new Uint8Array(32768);
    for (const id of ids.slice(1)) look[id] = 1;
    this.begin(`merge ${ids.join("+")}`);
    for (let i = 0; i < this.lab.length; i++) if (look[this.lab[i]]) this.lab[i] = keep;
    this.tile(keep).pawn_manual = false;
    const notes = ids.map((id) => this.tile(id)?.note).filter(Boolean);
    this.meta.tiles = this.meta.tiles.filter((t) => !look[t.id]);
    this.reindex();
    if (notes.length > 1) this.tile(keep).note = notes.join("\n");
    this.commit();
    return keep;
  }

  deleteTiles(ids) {
    const look = new Uint8Array(32768);
    for (const id of ids) look[id] = 1;
    this.begin(`delete ${ids.join(", ")}`);
    for (let i = 0; i < this.lab.length; i++) if (look[this.lab[i]]) this.lab[i] = 0;
    this.meta.tiles = this.meta.tiles.filter((t) => !look[t.id]);
    this.reindex();
    this.commit();
  }

  // brush: value = tile id, or 0 to erase
  beginStroke(value, protect) {
    this.begin(value ? `paint tile ${value}` : "erase");
    this.stroke = { value, protect, last: null };
  }
  strokeTo(c, r, radiusPx) {
    const s = this.stroke;
    if (!s) return null;
    const pts = [];
    if (s.last) {
      const [lc, lr] = s.last;
      const d = Math.hypot(c - lc, r - lr);
      const n = Math.max(1, Math.ceil(d / Math.max(1, radiusPx * 0.4)));
      for (let k = 1; k <= n; k++) pts.push([lc + (c - lc) * k / n, lr + (r - lr) * k / n]);
    } else pts.push([c, r]);
    s.last = [c, r];
    const rad = Math.max(0.5, radiusPx), r2 = rad * rad;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (const [pc, pr] of pts) {
      for (let rr = Math.max(0, Math.floor(pr - rad)); rr <= Math.min(this.H - 1, Math.ceil(pr + rad)); rr++) {
        for (let cc = Math.max(0, Math.floor(pc - rad)); cc <= Math.min(this.W - 1, Math.ceil(pc + rad)); cc++) {
          if ((cc - pc) ** 2 + (rr - pr) ** 2 > r2) continue;
          const i = rr * this.W + cc;
          const cur = this.lab[i];
          if (s.value) {
            if (!this.water[i]) continue;
            if (s.protect && cur !== 0 && cur !== s.value) continue;
          }
          if (cur !== s.value) {
            this.lab[i] = s.value;
            x0 = Math.min(x0, cc); x1 = Math.max(x1, cc); y0 = Math.min(y0, rr); y1 = Math.max(y1, rr);
          }
        }
      }
    }
    return x1 < 0 ? null : [x0, y0, x1, y1];
  }
  endStroke() { this.stroke = null; this.commit(); }

  renumber(cfg) {
    const a = this.ensureAnalysis(cfg);
    const band = Math.max(this.H / 6, 1);
    const tiles = [...this.meta.tiles].filter((t) => a.area[t.id] > 0);
    const key = (t) => {
      const p = a.pole[t.id];
      return [Math.floor(Math.floor(p / this.W) / band), p % this.W];
    };
    tiles.sort((x, y) => { const kx = key(x), ky = key(y); return kx[0] - ky[0] || kx[1] - ky[1]; });
    const map = new Int16Array(32768);
    tiles.forEach((t, i) => { map[t.id] = i + 1; });
    this.begin("renumber");
    for (let i = 0; i < this.lab.length; i++) if (this.lab[i] > 0) this.lab[i] = map[this.lab[i]];
    const old = new Map(tiles.map((t) => [t.id, map[t.id]]));
    for (const t of tiles) t.id = map[t.id];
    const arrows = {};
    for (const [key, edit] of Object.entries(this.meta.arrows)) {
      const [left, right] = key.split("-").map((id) => map[+id]);
      if (left && right) arrows[`${left}-${right}`] = edit;
    }
    this.meta.arrows = arrows;
    this.meta.tiles = tiles.sort((x, y) => x.id - y.id);
    this.reindex();
    this.commit();
    return old;
  }

  cleanupFragments() {
    this.begin("clean up fragments");
    const n = R.cleanupFragments(this.lab, this.W, this.H, Math.max(this.maxId(), this.labMax()));
    this.commit();
    return n;
  }

  recomputeAllPawns(cfg) {
    this.begin("recompute pawn spots", false);
    for (const t of this.meta.tiles) { t.pawn_manual = false; this.pendingAffected.add(t.id); }
    this.analysisVersion = -1;
    this.ensureAnalysis(cfg);
    this.commit();
  }

  // ------------------------------------------------------------ meta edits
  edit(label, fn) {
    this.begin(label, false);
    fn(this.meta);
    this.reindex();
    this.commit();
  }

  // a passage of the main config, in this board's mm
  passageFromConfig(p) {
    const mm = (ll) => this.proj.forward(ll[0], ll[1]);
    return { name: p.name, kind: p.kind, enabled: p.enabled !== false, source: "config",
             a_mm: mm(p.a), b_mm: mm(p.b), via_mm: (p.via || []).map(mm) };
  }
}

export function passagePoints(p) { return [p.a_mm, ...(p.via_mm || []), p.b_mm]; }

export function round2(v) { return Math.round(v * 100) / 100; }
