// Canvas view: pan/zoom, a raster overlay for tiles, and vector layers drawn on top.
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || "");
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [200, 200, 200];
}

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export class View {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.app = app;
    this.scale = 2;
    this.tx = 20;
    this.ty = 20;
    this.overlay = document.createElement("canvas");
    this.octx = this.overlay.getContext("2d");
    this.art = null;
    this.labelBoxes = [];
    this.pending = false;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  resize() {
    const el = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    this.cw = el.clientWidth;
    this.ch = el.clientHeight;
    this.canvas.width = Math.round(this.cw * dpr);
    this.canvas.height = Math.round(this.ch * dpr);
    this.canvas.style.width = this.cw + "px";
    this.canvas.style.height = this.ch + "px";
    if (!this.fitted && this.app.design) this.fit();
    this.requestDraw();
  }

  setDesign(d) {
    this.overlay.width = d.W;
    this.overlay.height = d.H;
    this.img = this.octx.createImageData(d.W, d.H);
    this.fitted = false;
    this.rebuildOverlay();
    if (this.cw) this.fit();
  }

  setArt(url) {
    this.art = null;
    if (!url) { this.requestDraw(); return; }
    const im = new Image();
    im.onload = () => { this.art = im; this.requestDraw(); };
    im.src = url;
  }

  fit() {
    const d = this.app.design;
    if (!d || !this.cw) return;
    const b = d.board;
    this.scale = Math.min(this.cw / b.width_mm, this.ch / b.height_mm) * 0.97;
    this.tx = (this.cw - b.width_mm * this.scale) / 2;
    this.ty = (this.ch - b.height_mm * this.scale) / 2;
    this.fitted = true;
    this.requestDraw();
  }

  centerOn(bx, by, minScale) {
    if (minScale && this.scale < minScale) this.scale = minScale;
    this.tx = this.cw / 2 - bx * this.scale;
    this.ty = this.ch / 2 - by * this.scale;
    this.requestDraw();
  }

  zoomAt(sx, sy, f) {
    const ns = Math.max(0.3, Math.min(80, this.scale * f));
    const k = ns / this.scale;
    this.tx = sx - (sx - this.tx) * k;
    this.ty = sy - (sy - this.ty) * k;
    this.scale = ns;
    this.requestDraw();
  }

  toBoard(sx, sy) { return [(sx - this.tx) / this.scale, (sy - this.ty) / this.scale]; }

  requestDraw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.draw(); });
  }

  // ---------------------------------------------------------------- raster overlay
  colourTables() {
    const app = this.app, d = app.design, vo = app.vo;
    const M = Math.max(d.maxId(), 1) + 2;
    const fill = new Uint8ClampedArray(M * 4);
    const seaIdx = new Int16Array(M).fill(-1);
    const flag = new Uint8Array(M);              // 1 selected, 2 problem
    const a = d.analysis;
    const pawnPx = (app.cfg?.tiles?.pawn_diameter_mm ?? 12) * d.ppm;
    const alpha = Math.round(255 * vo.fillAlpha);
    for (const t of d.meta.tiles) {
      if (t.id >= M) continue;
      const si = d.seaIndex(t.sea);
      seaIdx[t.id] = si;
      let rgb;
      if (vo.fill === "tile") rgb = hsl((t.id * 0.618034) % 1, 0.55, 0.55);
      else {
        rgb = hexToRgb(d.meta.seas[si]?.color || "#888888");
        const shade = 0.86 + 0.14 * ((t.id * 7) % 5) / 4;
        rgb = rgb.map((v) => v * shade);
      }
      fill.set([rgb[0], rgb[1], rgb[2], vo.fill === "none" ? 0 : alpha], t.id * 4);
      if (app.sel.tiles.has(t.id)) flag[t.id] |= 1;
      if (vo.problems && a) {
        const bad = (a.inscribedPx[t.id] || 0) * 2 < pawnPx || a.pieces[t.id] > 1 || (a.unreachable || []).includes(t.id);
        if (bad && a.area[t.id]) flag[t.id] |= 2;
      }
    }
    return { fill, seaIdx, flag, M };
  }

  rebuildOverlay(rect) {
    const d = this.app.design;
    if (!d || !this.img) return;
    const { W, H, lab, water } = d;
    const vo = this.app.vo;
    const { fill, seaIdx, flag, M } = this.colourTables();
    const ink = hexToRgb(this.app.cfg?.compose?.border_color || "#f4ecd8");
    const data = this.img.data;
    const [x0, y0, x1, y1] = rect
      ? [Math.max(0, rect[0] - 3), Math.max(0, rect[1] - 3), Math.min(W - 1, rect[2] + 3), Math.min(H - 1, rect[3] + 3)]
      : [0, 0, W - 1, H - 1];
    const showB = vo.borders, unassigned = vo.unassigned;
    const at = (c, r) => (c < 0 || r < 0 || c >= W || r >= H ? -1 : lab[r * W + c]);
    for (let r = y0; r <= y1; r++) {
      for (let c = x0; c <= x1; c++) {
        const i = r * W + c, o = i * 4;
        const t = lab[i];
        if (t <= 0) {
          if (unassigned && water[i]) { data[o] = 255; data[o + 1] = 80; data[o + 2] = 160; data[o + 3] = 70; }
          else data[o + 3] = 0;
          continue;
        }
        const tt = t < M ? t : 0;
        const sel = flag[tt] & 1;
        let border = 0, selEdge = false;
        if (showB || sel) {
          const n1 = [at(c - 1, r), at(c + 1, r), at(c, r - 1), at(c, r + 1)];
          for (const u of n1) {
            if (u === t) continue;
            if (sel && u !== t) selEdge = true;
            if (u > 0) border = Math.max(border, seaIdx[u < M ? u : 0] !== seaIdx[tt] ? 2 : 1);
          }
          if (border < 2 && showB) {
            for (const u of [at(c - 2, r), at(c + 2, r), at(c, r - 2), at(c, r + 2)]) {
              if (u > 0 && u !== t && seaIdx[u < M ? u : 0] !== seaIdx[tt]) { border = 2; break; }
            }
          }
          if (sel && !selEdge) {
            for (const u of [at(c - 2, r), at(c + 2, r), at(c, r - 2), at(c, r + 2), at(c - 3, r), at(c + 3, r), at(c, r - 3), at(c, r + 3)]) {
              if (u !== t) { selEdge = true; break; }
            }
          }
        }
        if (selEdge) { data[o] = 255; data[o + 1] = 210; data[o + 2] = 60; data[o + 3] = 255; continue; }
        if (showB && border === 2) { data[o] = ink[0]; data[o + 1] = ink[1]; data[o + 2] = ink[2]; data[o + 3] = 245; continue; }
        if (showB && border === 1) { data[o] = ink[0]; data[o + 1] = ink[1]; data[o + 2] = ink[2]; data[o + 3] = 170; continue; }
        let R = fill[tt * 4], G = fill[tt * 4 + 1], B = fill[tt * 4 + 2], A = fill[tt * 4 + 3];
        if (flag[tt] & 2) {
          const stripe = ((c + r) >> 3) & 1;
          R = 230; G = 60; B = 60; A = stripe ? 120 : Math.max(A, 50);
        }
        if (sel) { R = R * 0.6 + 255 * 0.4; G = G * 0.6 + 230 * 0.4; B = B * 0.6 + 120 * 0.4; A = Math.max(A, 110); }
        data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = A;
      }
    }
    this.octx.putImageData(this.img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    this.requestDraw();
  }

  // ---------------------------------------------------------------- drawing
  draw() {
    const ctx = this.ctx, app = this.app, d = app.design, vo = app.vo, cfg = app.cfg;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--stage").trim() || "#0b141c";
    ctx.fillRect(0, 0, this.cw, this.ch);
    if (!d) return;
    const b = d.board, fr = d.frame;
    const iw = b.inner_width_mm, ih = b.inner_height_mm, MH = b.map_height_mm, PH = b.panel_height_mm;
    const ink = cfg.compose.border_color, font = `"${cfg.compose.font}", "DejaVu Serif", Georgia, serif`;
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);
    // board, frame, panel
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 18;
    ctx.fillStyle = cfg.webtool?.frame_color || "#16324a";
    ctx.fillRect(0, 0, b.width_mm, b.height_mm);
    ctx.restore();
    ctx.save();
    ctx.translate(fr.left, fr.top);
    ctx.fillStyle = cfg.day_track.panel_color;
    ctx.fillRect(0, 0, iw, ih);
    if (vo.art && this.art) ctx.drawImage(this.art, 0, 0, iw, MH);
    else { ctx.fillStyle = "#3d6f93"; ctx.fillRect(0, 0, iw, MH); }
    ctx.imageSmoothingEnabled = this.scale * (iw / d.W) < 1.5;
    ctx.drawImage(this.overlay, 0, 0, iw, MH);
    ctx.imageSmoothingEnabled = true;

    const a = d.analysis;
    // passages
    if (vo.passages && a?.passageInfo) {
      for (const pi of a.passageInfo) {
        const p = pi.p;
        if (!p.enabled) continue;
        const ok = pi.status === "ok";
        if (ok && !pi.drawn && app.sel.passage !== p) continue;
        const [ax, ay] = p.a_mm, [bx, by] = p.b_mm;
        ctx.lineCap = "round";
        ctx.strokeStyle = "rgba(11,29,43,0.5)"; ctx.lineWidth = 1.8; ctx.setLineDash([]);
        line(ctx, ax, ay, bx, by);
        ctx.strokeStyle = !ok ? "#ff6b6b" : app.sel.passage === p ? "#ffd23c" : ink;
        ctx.lineWidth = 0.9;
        ctx.setLineDash(p.kind === "canal" ? [2.2, 1.4] : p.kind === "strait" ? [0.6, 1.2] : [3, 1, 0.6, 1]);
        line(ctx, ax, ay, bx, by);
        ctx.setLineDash([]);
        for (const [x, y] of [p.a_mm, p.b_mm]) {
          ctx.beginPath(); ctx.arc(x, y, 0.9, 0, 7);
          ctx.fillStyle = ink; ctx.fill(); ctx.lineWidth = 0.3; ctx.strokeStyle = "#0b1d2b"; ctx.stroke();
        }
      }
    }
    // wrap arrows
    if (vo.wraps && a?.wraps) {
      for (const w of a.wraps) {
        const y = (w.row + 0.5) / d.ppm;
        for (const [x, s, target] of [[0, -1, w.right], [iw, 1, w.left]]) {
          const base = x - s * 3.2;
          ctx.beginPath(); ctx.moveTo(base, y - 2.2); ctx.lineTo(x, y); ctx.lineTo(base, y + 2.2); ctx.closePath();
          ctx.fillStyle = ink; ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
          ctx.lineWidth = 0.3; ctx.strokeStyle = "#0b1d2b"; ctx.stroke();
          ctx.font = `bold 3.2px ${font}`;
          ctx.textAlign = s < 0 ? "left" : "right";
          haloText(ctx, String(target), base - s * 0.8, y + 1.1, ink, "#0b1d2b", 0.45);
        }
      }
    }
    // pawn circles and numbers
    const pawnR = (cfg.tiles.pawn_diameter_mm ?? 12) / 2;
    if (vo.circles || vo.numbers) {
      for (const t of d.meta.tiles) {
        if (!t.pawn_mm) continue;
        const [x, y] = t.pawn_mm;
        const sel = app.sel.tiles.has(t.id);
        if (vo.circles) {
          ctx.beginPath(); ctx.arc(x, y, pawnR, 0, 7);
          ctx.setLineDash([1, 0.8]);
          ctx.strokeStyle = sel ? "#ffd23c" : ink;
          ctx.globalAlpha = sel ? 1 : 0.6; ctx.lineWidth = sel ? 0.5 : 0.35; ctx.stroke();
          ctx.globalAlpha = 1; ctx.setLineDash([]);
        }
        if (vo.numbers) {
          ctx.font = `bold 4px ${font}`; ctx.textAlign = "center";
          haloText(ctx, String(t.id), x, y + 1.4, sel ? "#ffd23c" : ink, "#0b1d2b", 0.5);
          if (t.pinned) { ctx.font = `2.4px ${font}`; haloText(ctx, "📌", x + 3.4, y - 2.4, ink, "#0b1d2b", 0.2); }
        }
      }
    }
    // sea labels
    this.labelBoxes = [];
    if (vo.labels) {
      const lang = cfg.compose.language;
      const counts = new Map();
      for (const t of d.meta.tiles) counts.set(t.sea, (counts.get(t.sea) || 0) + 1);
      for (const s of d.meta.seas) {
        if (!s.label_mm || s.show_label === false || !counts.get(s.name)) continue;
        const ocean = s.class === "ocean";
        const size = s.label_size_mm || (ocean ? cfg.compose.ocean_label_mm : cfg.compose.sea_label_mm);
        const spacing = (ocean ? 0.2 : 0.05) * size;
        let text = lang === "nl" ? s.name_nl || s.name : s.name;
        if (ocean) text = text.toUpperCase();
        ctx.font = `italic ${size}px ${font}`;
        const [x, y] = s.label_mm;
        const wbox = spacedWidth(ctx, text, spacing);
        const sel = app.sel.sea === s.name;
        spacedText(ctx, text, x, y + size * 0.36, spacing, sel ? "#ffd23c" : ink, "rgba(11,29,43,0.6)", size * 0.12);
        this.labelBoxes.push({ sea: s.name, x: x - wbox / 2, y: y - size * 0.55, w: wbox, h: size * 1.1 });
        if (sel) {
          ctx.strokeStyle = "#ffd23c"; ctx.lineWidth = 0.3; ctx.setLineDash([1, 1]);
          ctx.strokeRect(x - wbox / 2 - 1, y - size * 0.6, wbox + 2, size * 1.2); ctx.setLineDash([]);
        }
      }
    }
    if (PH > 5) {       // top edge of the bottom panel
      ctx.strokeStyle = ink; ctx.lineWidth = 0.6;
      line(ctx, 0, MH, iw, MH);
    }
    // link tool: first point
    if (app.linkStart) {
      ctx.beginPath(); ctx.arc(app.linkStart[0], app.linkStart[1], 1.2, 0, 7);
      ctx.fillStyle = "#ffd23c"; ctx.fill();
      if (app.hoverMap) { ctx.strokeStyle = "#ffd23c"; ctx.lineWidth = 0.5; ctx.setLineDash([1, 1]); line(ctx, ...app.linkStart, ...app.hoverMap); ctx.setLineDash([]); }
    }
    // move tool ghost
    if (app.drag?.type === "moveTile" && app.drag.cur) {
      const [x, y] = app.drag.cur;
      ctx.beginPath(); ctx.arc(x, y, pawnR, 0, 7);
      ctx.fillStyle = "rgba(255,210,60,0.35)"; ctx.fill();
      ctx.strokeStyle = "#ffd23c"; ctx.lineWidth = 0.6; ctx.stroke();
      const t = d.tile(app.drag.id);
      if (t?.pawn_mm) { ctx.setLineDash([1.5, 1]); line(ctx, t.pawn_mm[0], t.pawn_mm[1], x, y); ctx.setLineDash([]); }
    }
    ctx.restore();

    // fields (board coordinates)
    if (vo.fields) {
      const text = boardText(app);
      for (const f of d.meta.fields) if (!f.hidden) drawField(ctx, f, app.sel.field === f.id, ink, font, text);
    }
    // map outline
    ctx.strokeStyle = "rgba(255,255,255,0.15)"; ctx.lineWidth = 1 / this.scale;
    ctx.strokeRect(fr.left, fr.top, iw, ih);
    // brush cursor
    if ((app.tool === "paint" || app.tool === "erase") && app.hoverBoard) {
      ctx.beginPath(); ctx.arc(app.hoverBoard[0], app.hoverBoard[1], app.opts.brushMm, 0, 7);
      ctx.strokeStyle = app.tool === "erase" ? "#ff8080" : "#ffffff"; ctx.lineWidth = 1.2 / this.scale; ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------- helpers
function line(ctx, ax, ay, bx, by) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function haloText(ctx, text, x, y, fill, halo, width) {
  ctx.lineJoin = "round";
  ctx.strokeStyle = halo; ctx.lineWidth = width * 2;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function spacedWidth(ctx, text, spacing) {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacing;
  return w - spacing;
}

function spacedText(ctx, text, cx, y, spacing, fill, halo, haloW) {
  const total = spacedWidth(ctx, text, spacing);
  let x = cx - total / 2;
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  const chars = [...text];
  const xs = chars.map((ch) => { const p = x; x += ctx.measureText(ch).width + spacing; return p; });
  ctx.strokeStyle = halo; ctx.lineWidth = haloW * 2;
  chars.forEach((ch, i) => ctx.strokeText(ch, xs[i], y));
  ctx.fillStyle = fill;
  chars.forEach((ch, i) => ctx.fillText(ch, xs[i], y));
}

export function fieldPath(ctx, f) {
  const w = f.w, h = f.h;
  ctx.beginPath();
  if (f.shape === "circle") ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (f.shape === "hex") {
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i + 30);
      const px = (w / 2) * Math.cos(a), py = (h / 2) * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  } else if (f.shape === "diamond") {
    ctx.moveTo(0, -h / 2); ctx.lineTo(w / 2, 0); ctx.lineTo(0, h / 2); ctx.lineTo(-w / 2, 0); ctx.closePath();
  } else roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * (f.shape === "rounded" ? 0.18 : 0.04));
}

export function boardText(app) {
  return app.text[app.cfg.compose.language] || app.text.en;
}

// A day keeps following the board language until its label is renamed (label null = default name).
export function fieldLabels(f, text) {
  const isDay = f.day != null;
  return {
    label: String(f.label ?? (isDay ? text.days[f.day] : "")),
    sub: String(f.sublabel ?? (isDay ? text.day_names[f.day] : "")),
  };
}

function drawLegend(ctx, f, ink, font, text) {
  const k = Math.min(f.w / 62, f.h / 18);
  const colour = f.text_color || ink;
  ctx.save();
  ctx.scale(k, k);
  ctx.globalAlpha = f.opacity ?? 1;
  ctx.fillStyle = colour; ctx.strokeStyle = colour; ctx.lineWidth = 0.9; ctx.lineCap = "butt";
  ctx.textAlign = "left"; ctx.font = `3.6px ${font}`;
  [[2.2, 1.4], [0.6, 1.2], null].forEach((dash, i) => {
    const y = -6 + 6 * i;
    if (dash) { ctx.setLineDash(dash); line(ctx, -30, y, -20, y); ctx.setLineDash([]); }
    else { ctx.beginPath(); ctx.moveTo(-30, y - 2); ctx.lineTo(-26.8, y); ctx.lineTo(-30, y + 2); ctx.closePath(); ctx.fill(); }
    ctx.fillText(text.legend[i], -17, y + 1.3);
  });
  ctx.restore();
}

// same layout as field_svg / legend_svg in server.py
export function drawField(ctx, f, selected, ink, font, text) {
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(((f.rotation || 0) * Math.PI) / 180);
  if (f.shape === "legend") drawLegend(ctx, f, ink, font, text);
  else {
    fieldPath(ctx, f);
    ctx.globalAlpha = f.opacity ?? 1;
    ctx.fillStyle = f.color || "#c8743a";
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = f.stroke || ink;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    const { label, sub } = fieldLabels(f, text);
    const size = Math.min(f.w, f.h);
    ctx.textAlign = "center";
    ctx.fillStyle = f.text_color || ink;
    if (label) {
      const lines = label.split("\n");
      const fs = f.font_mm || (sub ? Math.round(size * 3) / 10 : Math.max(size * 0.28, 1.5));
      const base = sub ? f.h * 0.02 - (lines.length - 1) * fs * 1.2 : fs * 0.35 - (lines.length - 1) * fs * 0.6;
      ctx.font = `bold ${fs}px ${font}`;
      lines.forEach((ln, i) => ctx.fillText(ln, 0, base + i * fs * 1.2));
    }
    if (sub) {
      ctx.font = `italic ${(size * 0.13).toFixed(1)}px ${font}`;
      ctx.globalAlpha = 0.85;
      ctx.fillText(sub, 0, f.h * (label ? 0.3 : 0.05));
      ctx.globalAlpha = 1;
    }
  }
  if (selected) {
    ctx.strokeStyle = "#ffd23c";
    ctx.lineWidth = 0.7;
    ctx.setLineDash([1.2, 0.8]);
    ctx.strokeRect(-f.w / 2 - 1, -f.h / 2 - 1, f.w + 2, f.h + 2);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

export function fieldHit(f, x, y) {
  if (f.hidden) return false;
  const a = (-(f.rotation || 0) * Math.PI) / 180;
  const dx = x - f.x, dy = y - f.y;
  const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
  if (f.shape === "circle") return (lx / (f.w / 2)) ** 2 + (ly / (f.h / 2)) ** 2 <= 1;
  return Math.abs(lx) <= f.w / 2 && Math.abs(ly) <= f.h / 2;
}
