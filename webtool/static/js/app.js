// Sea Board Designer: UI wiring (menubar, config menus, tools, sidebar, jobs, save/load).
import { Design, round2, passagePoints } from "./design.js";
import { View, fieldHit, fieldLabels, boardText, arrowPart } from "./render.js";

// ================================================================ small helpers
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "selected" || k === "disabled") e[k] = v;
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(d));
const clone = (o) => JSON.parse(JSON.stringify(o));
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : await res.arrayBuffer();
  if (!res.ok) {
    const err = new Error((body && body.error) || res.statusText);
    err.status = res.status;
    throw err;
  }
  return body;
}
const putJSON = (p, o) => api(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const postJSON = (p, o) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o || {}) });

function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem("seaboard." + key));
    localStorage.setItem("seaboard." + key, JSON.stringify(val));
  } catch { return undefined; }
  return val;
}

// ================================================================ state
const app = {
  cfg: null, defaults: null, comments: {}, design: null, view: null,
  tool: "select",
  sel: { tiles: new Set(), field: null, passage: null, sea: null, arrow: null },
  // editing aids, screen only (what the board shows is in design.look and compose.*)
  vo: Object.assign({ problems: true, unassigned: false }, store("aids") || {}),
  beforeLook: store("vo") || {},    // View settings from before they moved into the design
  opts: Object.assign({ iterations: 12, relaxNeighbours: true, scope: "same", splitNeighbours: false, newTileArea: 0,
    brushMm: 3, protect: false, lockTile: 0, linkKind: "canal", autosave: true,
    field: { shape: "rounded", w: 20, h: 20, kind: "field", color: "#c8743a", label: "" } }, store("opts") || {}),
  tab: "inspect", jobLog: [], job: null, drag: null, linkStart: null, hoverMap: null, hoverBoard: null,
};
window.seaboard = app;   // handy in the browser console

const TOOLS = [
  { id: "select", key: "v", name: "Select", icon: '<path d="M5 3l14 8-6 1.5L10 19z" fill="currentColor"/>' },
  { id: "move", key: "m", name: "Move tile", icon: '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>' },
  { id: "add", key: "a", name: "Add / split tile", icon: '<path d="M4 4h16v16H4z M12 4v16" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M17 15v6M14 18h6" stroke="currentColor" stroke-width="2.2"/>' },
  { id: "merge", key: "g", name: "Merge tiles", icon: '<path d="M3 6h7v12H3zM14 6h7v12h-7z" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M9 12h6M13 10l2 2-2 2" stroke="currentColor" stroke-width="1.8" fill="none"/>' },
  { id: "paint", key: "b", name: "Brush (extend a tile)", icon: '<path d="M14 4l6 6-8 8-6-6z" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M6 12l-3 7 7-3" stroke="currentColor" stroke-width="1.8" fill="none"/>' },
  { id: "erase", key: "e", name: "Eraser (make water unplayable)", icon: '<path d="M4 16l8-10 8 6-7 9H8z" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 11l7 6" stroke="currentColor" stroke-width="1.8"/>' },
  "sep",
  { id: "field", key: "f", name: "Fields (board edge spaces)", icon: '<rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M17.5 14v7M14 17.5h7" stroke="currentColor" stroke-width="2"/>' },
  { id: "link", key: "l", name: "Link (passage between tiles)", icon: '<path d="M9 15l6-6M7 11l-2 2a3.5 3.5 0 005 5l2-2M17 13l2-2a3.5 3.5 0 00-5-5l-2 2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>' },
  { id: "pan", key: "h", name: "Pan (or hold Space / middle mouse)", icon: '<path d="M8 13V6a1.5 1.5 0 013 0v5V4.5a1.5 1.5 0 013 0V11V6a1.5 1.5 0 013 0v8c0 4-2.5 7-6 7s-5-2-7-5l-1.5-2.5a1.4 1.4 0 012.3-1.6z" stroke="currentColor" stroke-width="1.6" fill="none"/>' },
];

const SECTION_TITLES = { board: "Board", map: "Map", tiles: "Tiles", seas: "Seas", passages: "Passages",
  art: "Map image", compose: "Compose", day_track: "Day track", webtool: "Frame" };
const EDIT_KEYS = ["tiles.border_noise", "tiles.noise_scale_mm"];
const LIVE_KEYS = ["tiles.pawn_diameter_mm", "tiles.min_wrap_edge_mm",
  "webtool.frame_color", "webtool.snap_mm", "day_track.panel_color"];
const LIVE_PREFIX = ["compose"];
const FIELD_KINDS = ["track", "event", "harbour", "deck", "card slot", "score", "threat", "reserve", "storage", "rule"];

// ================================================================ toast / status / dialogs
let toastTimer;
function toast(msg, error) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), error ? 5000 : 2600);
  $("#st-msg").textContent = msg;
}

function dialog(title, body, buttons = [{ label: "Close", value: "close" }]) {
  const dlg = $("#dialog");
  $("#dlg-title").textContent = title;
  const b = $("#dlg-body");
  b.replaceChildren(...[].concat(body));
  const bar = $("#dlg-buttons");
  bar.replaceChildren(...buttons.map((x) => h("button", { value: x.value, class: x.primary ? "primary" : x.danger ? "danger" : "" }, x.label)));
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue);
    dlg.returnValue = "";
    dlg.showModal();
    const first = b.querySelector("input,select,textarea");
    if (first) first.focus();
  });
}
async function confirmBox(title, msg, okLabel = "OK", danger) {
  return (await dialog(title, h("p", {}, msg), [{ label: "Cancel", value: "cancel" },
    { label: okLabel, value: "ok", primary: !danger, danger }])) === "ok";
}
async function promptBox(title, label, value, okLabel = "OK") {
  const inp = h("input", { type: "text", value });
  const r = await dialog(title, h("div", { class: "dlgrow" }, h("label", {}, label), inp),
    [{ label: "Cancel", value: "cancel" }, { label: okLabel, value: "ok", primary: true }]);
  return r === "ok" ? inp.value.trim() : null;
}

// ================================================================ boot
async function boot() {
  app.view = new View($("#view"), app);
  buildToolbar();
  buildTabs();
  bindCanvas();
  bindKeys();
  $("#empty-generate").onclick = () => generateDialog();
  $("#empty-open").onclick = () => openDialog();
  $("#regen-flag").onclick = () => generateDialog();
  $("#jobpill").onclick = () => setTab("log");
  try {
    const st = await api("/api/state");
    app.cfg = st.config; app.defaults = st.defaults; app.comments = st.comments; app.paths = st.paths; app.text = st.board_text;
    app.lookDefault = st.look_default; app.lookBefore = st.look_before;
    if (!app.text || app.lookDefault?.arrow_size === undefined || !app.defaults) {        // the page is new but the Python server still runs the old code
      toast("The tool was updated: restart the server (run.sh), then reload this page.", true);
      return;
    }
    buildMenus();
    setTool(app.tool);
    watchData(st.data);
    if (st.job && st.job.status === "running") watchJob(st.job);
    const last = st.state?.last_design;
    if (last && st.designs.some((d) => d.name === last)) await openDesign(last);
    else if (st.designs.length) await openDesign(st.designs[0].name);
    else showEmpty(true);
  } catch (e) {
    toast("Could not reach the server: " + e.message, true);
  }
  setInterval(autosave, 60000);
  window.addEventListener("beforeunload", (e) => { if (app.design?.dirty) { e.preventDefault(); e.returnValue = ""; } });
}

function showEmpty(on) { $("#empty").hidden = !on; }

// ================================================================ designs: open / save
async function openDesign(name) {
  if (app.design?.dirty && app.design.meta.name !== name) {
    if (!(await confirmBox("Unsaved changes", `Discard the unsaved changes in '${app.design.meta.name}'?`, "Discard", true))) return;
  }
  toast(`Opening ${name}…`);
  const enc = encodeURIComponent(name);
  const [meta, labels, water] = await Promise.all([api(`/api/designs/${enc}`), api(`/api/designs/${enc}/labels`), api(`/api/designs/${enc}/water`)]);
  meta.look = meta.look ? { ...app.lookDefault, ...meta.look } : lookFromBefore();
  const d = new Design(meta, new Int16Array(labels), new Uint8Array(water));
  app.design = d;
  app.sel = { tiles: new Set(), field: null, passage: null, sea: null, arrow: null };
  d.setNoise(app.cfg.tiles);
  d.dirty = false;
  d.on(onDesignChange);
  d.ensureAnalysis(app.cfg);
  app.view.setDesign(d);
  updateArt(true);
  await updateFont();
  showEmpty(false);
  updateDocInfo();
  refreshSidebar();
  checkRegen();
  toast(`Opened ${name}: ${d.meta.tiles.length} tiles, ${d.meta.fields.length} fields`);
}

// designs from before View moved into the design keep what this browser showed (circles: off, as decided)
function lookFromBefore() {
  const was = app.beforeLook, look = { ...app.lookBefore };
  for (const k of ["borders", "passages", "wraps", "fields", "fill"]) if (was[k] !== undefined) look[k] = was[k];
  if (was.fillAlpha !== undefined) look.fill_opacity = was.fillAlpha;
  return look;
}

// names are italic only where the export will have an italic font
async function updateFont() {
  const family = app.cfg.compose.font;
  if (app.fontAsked === family) return;
  app.fontAsked = family;
  try {
    const got = await api("/api/font?family=" + encodeURIComponent(family));
    if (app.cfg.compose.font !== family) return;
    app.italic = got.italic;
    app.view.requestDraw();
  } catch { app.fontAsked = null; }
}

function updateArt(force) {
  const d = app.design;
  if (!d) return;
  const file = app.cfg.compose.map_art && d.meta.has_art ? "art" : null;
  const key = `${d.meta.name}/${file}`;
  if (!force && key === app.artKey) return;
  app.artKey = key;
  app.view.setArt(file ? `/api/designs/${encodeURIComponent(d.meta.name)}/${file}.jpg?v=${Date.now()}` : null);
}

async function saveDesign(quiet) {
  const d = app.design;
  if (!d) return;
  if (app.replacing === d.meta.name) {      // a job is replacing this design: saving would undo that
    if (!quiet) toast(`Not saved: '${d.meta.name}' is being replaced (see the Log tab)`, true);
    return;
  }
  if (!d.tx) d.ensureAnalysis(app.cfg);     // pawn spots of the last edit
  const version = d.version;
  const enc = encodeURIComponent(d.meta.name);
  await putJSON(`/api/designs/${enc}`, d.meta);
  await api(`/api/designs/${enc}/labels`, { method: "PUT", body: d.lab.buffer.byteLength === d.lab.byteLength ? d.lab : d.lab.slice() });
  if (d.version === version) d.dirty = false;
  updateDocInfo();
  if (!quiet) toast(`Saved ${d.meta.name}`);
}

async function saveAs() {
  const d = app.design;
  if (!d) return;
  const name = await promptBox("Save design as", "New name", d.meta.name + "-copy", "Save");
  if (!name) return;
  try {
    await postJSON(`/api/designs/${encodeURIComponent(d.meta.name)}/copy`, { to: name });
    d.meta.name = name;
    await saveDesign();
  } catch (e) { toast(e.message, true); }
}

async function autosave() {
  if (app.opts.autosave && app.design?.dirty && !app.drag && !app.design.tx) {
    try { await saveDesign(true); $("#st-msg").textContent = "autosaved " + new Date().toLocaleTimeString(); } catch { /* next time */ }
  }
}

function updateDocInfo() {
  const d = app.design;
  $("#docname").textContent = d ? d.meta.name : "no design";
  $("#dirty").className = d?.dirty ? "on" : "";
  document.title = (d ? (d.dirty ? "• " : "") + d.meta.name + " – " : "") + "Sea Board Designer";
}

async function openDialog() {
  const { designs } = await api("/api/designs");
  if (!designs.length) { toast("No designs yet"); return; }
  const list = h("div", { class: "list" }, designs.map((x) => h("div", {
    class: "li", onclick: () => { $("#dialog").close("cancel"); openDesign(x.name); },
  }, h("span", { class: "grow" }, h("b", {}, x.name), h("br"), h("span", { class: "muted" }, x.source || "")),
  h("span", { class: "num" }, `${x.tiles} tiles · ${x.fields} fields`), h("span", { class: "num" }, new Date(x.modified * 1000).toLocaleString()))));
  await dialog("Open design", list, [{ label: "Cancel", value: "cancel" }]);
}

function downloadJSON() {
  const d = app.design;
  if (!d) return;
  const a = d.ensureAnalysis(app.cfg);
  const out = clone(d.meta);
  out.fields.forEach((f) => {
    if (f.day != null) { const n = fieldLabels(f, boardText(app)); f.label = n.label; f.sublabel = n.sub; }
  });
  out.crossings = a.wraps.map(({ left, right, y_mm, hidden, closed }) => ({ left, right, y_mm, hidden, closed }));
  out.tiles.forEach((t) => {
    t.area_mm2 = round2(a.area[t.id] / d.ppm / d.ppm);
    t.inscribed_diameter_mm = round2((a.inscribedPx[t.id] * 2) / d.ppm);
    t.neighbours = [...(a.graph.get(t.id)?.entries() || [])].map(([id, kind]) => ({ id, kind }));
  });
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
  const link = h("a", { href: URL.createObjectURL(blob), download: d.meta.name + ".json" });
  link.click();
}

// ================================================================ design change handling
let analysisTimer;
function onDesignChange(kind, info) {
  updateDocInfo();
  if (kind === "changed") {
    pruneSelection();
    app.view.rebuildOverlay(null);
    clearTimeout(analysisTimer);
    analysisTimer = setTimeout(runAnalysis, 120);
  } else if (kind === "meta" || kind === "pawns") {
    app.view.requestDraw();
    scheduleSidebar();
  }
}

function runAnalysis() {
  const d = app.design;
  if (!d) return;
  d.ensureAnalysis(app.cfg);
  if (app.sel.arrow && !findArrow(app.sel.arrow)) app.sel.arrow = null;     // that crossing is gone
  app.view.rebuildOverlay(null);
  refreshSidebar();
}

function pruneSelection() {
  const d = app.design;
  for (const id of [...app.sel.tiles]) if (!d.tile(id)) app.sel.tiles.delete(id);
  if (app.sel.field && !d.meta.fields.some((f) => f.id === app.sel.field)) app.sel.field = null;
  if (app.sel.passage && !d.meta.passages.includes(app.sel.passage)) app.sel.passage = null;
}

function select(kind, value, add) {
  if (kind !== "tiles" || !add) app.sel = { tiles: new Set(), field: null, passage: null, sea: null, arrow: null };
  if (kind === "tiles") {
    for (const id of [].concat(value)) {
      if (add && app.sel.tiles.has(id)) app.sel.tiles.delete(id); else app.sel.tiles.add(id);
    }
  } else if (kind) app.sel[kind] = value;
  app.view.rebuildOverlay(null);
  // stay on the log only while a job is running
  if (app.tab !== "log" || app.job?.status !== "running") setTab(kind === "sea" ? "seas" : "inspect", true);
  refreshSidebar();
}

// ================================================================ jobs
async function launchJob(req) {
  const { job } = await postJSON("/api/jobs", req);
  app.jobLog = [];
  watchJob(job);
  setTab("log");
}

async function startJob(req) {
  try { await launchJob(req); return true; } catch (e) { toast(e.message, true); return false; }
}

// generate into a design name; an existing design is only replaced after asking
async function startDesignJob(req) {
  try {
    await launchJob(req);
    return;
  } catch (e) {
    if (e.status !== 409 || !/already exists/.test(e.message)) { toast(e.message, true); return; }
  }
  const open = app.design?.meta.name === req.name;
  if (!(await confirmBox("Replace design", `A design named '${req.name}' already exists. Replace it?` +
    (open ? " It is the design you have open: its tiles and all edits are replaced." : " Its tiles and all edits are replaced.") +
    " This cannot be undone.", "Replace", true))) return;
  if (open) app.replacing = req.name;       // no saving over the new design while the job runs
  if (!(await startJob({ ...req, replace: true }))) app.replacing = null;
}

function watchJob(job) {
  app.job = job;
  app.jobLog = job.log || [];
  const pill = $("#jobpill");
  pill.hidden = false;
  pill.className = "";
  const tick = async () => {
    try {
      const { job: j } = await api(`/api/jobs/current?since=${app.jobLog.length}`);
      if (!j || j.id !== app.job.id) return;
      app.jobLog.push(...j.log);
      app.job = j;
      const secs = Math.round(((j.ended || Date.now() / 1000) - j.started));
      pill.textContent = `${j.title} · ${j.status === "running" ? secs + " s" : j.status}`;
      if (app.tab === "log") renderLog();
      if (j.status === "running") { setTimeout(tick, 800); return; }
      pill.className = j.status === "done" ? "" : "error";
      setTimeout(() => { if (app.job === j && j.status === "done") pill.hidden = true; }, 6000);
      if (j.status === "done") jobDone(j);
      else { app.replacing = null; toast(`${j.title}: ${j.error || j.status}`, true); }
    } catch (e) { setTimeout(tick, 2000); }
  };
  tick();
}

// map data: downloaded in the background at first start; editing and export never wait for it
function watchData(data) {
  const pill = $("#datapill");
  let failed = false, timer = 0;
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
  pill.onclick = async () => {
    if (!pill.classList.contains("error")) return;
    try { show(await postJSON("/api/data/retry")); } catch (e) { toast(e.message, true); }
    later(500);
  };
  function show(d) {
    if (!d) return;
    const mb = (n) => Math.round(n / 1048576);
    pill.hidden = d.state === "ready";
    pill.classList.toggle("error", d.state === "error");
    if (d.state === "downloading") {
      pill.textContent = `Map data · ${d.total ? Math.floor((100 * d.done) / d.total) + " %" : mb(d.done) + " MB"}` +
        (d.parts > 1 ? ` · part ${d.parts - d.missing.length + 1} of ${d.parts}` : "");
      pill.title = `Downloading ${d.current} into ${d.dir}. Editing and export work meanwhile; Generate and the map image wait for it.`;
    } else if (d.state === "error") {
      pill.textContent = "Map data missing · Retry";
      pill.title = `Download failed: ${d.error}. Click to try again.`;
      if (!failed) toast(`Map data could not be downloaded (${d.error}). Click "Retry" at the top to try again.`, true);
    } else {
      pill.textContent = "Map data · checking";
      pill.title = "Checking the map data";
    }
    failed = d.state === "error";
  }
  async function tick() {
    try {
      const d = await api("/api/data");
      show(d);
      if (d.state === "checking" || d.state === "downloading") later(1000);
      else if (d.state === "error") later(5000);      // a Generate may start a new try
    } catch (e) { later(3000); }
  }
  show(data);
  if (data && data.state !== "ready") tick();
}

async function jobDone(j) {
  const r = j.result || {};
  if (j.kind === "generate") {
    const replaced = app.replacing === r.design && app.design?.meta.name === r.design;
    app.replacing = null;
    if (replaced) app.design.dirty = false;         // its edits were replaced on purpose: don't ask about them
    else if (app.design?.dirty) await saveDesign(true).catch(() => {});
    await openDesign(r.design);
  } else if (j.kind === "art") {
    if (app.design && r.design === app.design.meta.name) {
      app.design.meta.has_art = true;
      app.design.meta.run_dir = r.run_dir;
      updateArt(true);
      toast("New map image loaded");
    }
  } else if (j.kind === "export") showExport(r);
}

function showExport(r) {
  const enc = encodeURIComponent(r.design);
  const base = `/api/designs/${enc}/export/`;
  dialog(`Export of ${r.design}`, [
    h("div", { class: "preview" }, h("img", { src: base + "board_preview.jpg?v=" + r.stamp })),
    h("p", {}, "Composed with your settings, View choices, frame and fields. Files in ", h("code", {}, r.dir)),
    h("div", { class: "row" }, r.files.map((f) => h("a", { href: base + f + "?download=1", class: "chip", download: f.split("/").pop() }, f))),
  ]);
}

async function generateDialog() {
  const name = h("input", { type: "text", value: "gen-" + stamp() });
  const guide = h("input", { type: "checkbox", checked: true });
  const fr = app.cfg.webtool.frame;
  const r = await dialog("Generate new tiles", [
    h("p", {}, "Makes new tiles with the settings from the menubar (one to two minutes) and opens the result as a new design. Your current design stays as it is."),
    h("p", { class: "muted" }, `Board ${app.cfg.board.width_mm}×${app.cfg.board.height_mm} mm, frame ${fr.top}/${fr.right}/${fr.bottom}/${fr.left} mm, ${app.cfg.tiles.count} tiles, ${app.cfg.seas.biggest} biggest seas.`),
    h("div", { class: "dlgrow" }, h("label", {}, "New design name"), name),
    h("div", { class: "dlgrow" }, h("label", {}, "Map image"), h("label", {}, guide, " make the atlas map too (a few seconds)")),
  ], [{ label: "Cancel", value: "cancel" }, { label: "Generate", value: "ok", primary: true }]);
  if (r !== "ok") return;
  if (app.design?.dirty) await saveDesign(true).catch(() => {});
  startDesignJob({ kind: "generate", name: name.value.trim(), guide: guide.checked });
}

async function exportDialog() {
  if (!app.design) return;
  const png = h("input", { type: "checkbox" });
  const r = await dialog("Export the board", [
    $("#regen-flag").hidden ? null : h("p", { class: "warn" }, "Some changed settings (marked 'regenerate') need new tiles. This export keeps the tiles you see."),
    h("p", {}, "Saves the design, then builds board.svg, board.pdf and a preview with the frame and the fields, and writes tiles.json (with neighbours, passages and fields) for later use in the game."),
    h("div", { class: "dlgrow" }, h("label", {}, "Print PNG"), h("label", {}, png, ` also board.png at ${app.cfg.compose.print_dpi} dpi (slow)`)),
  ].filter(Boolean), [{ label: "Cancel", value: "cancel" }, { label: "Export", value: "ok", primary: true }]);
  if (r !== "ok") return;
  try {
    await saveConfig();
    await saveDesign(true);
  } catch (e) { toast("Not exported, saving failed: " + e.message, true); return; }
  startJob({ kind: "export", name: app.design.meta.name, png: png.checked });
}

function artJob() {
  if (app.design) startJob({ kind: "art", name: app.design.meta.name });
}

// ================================================================ menubar
let openMenu = null;
function closeMenus() { document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")); openMenu = null; }
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".menu")) closeMenus(); });

function menu(title, build, cls = "") {
  const dd = h("div", { class: "dropdown" });
  const m = h("div", { class: "menu" }, h("button", {
    class: "mtitle " + cls,
    onclick: () => {
      const was = m.classList.contains("open");
      closeMenus();
      if (!was) { dd.replaceChildren(...[].concat(build())); m.classList.add("open"); openMenu = m; }
    },
    onpointerenter: () => {
      if (openMenu && openMenu !== m) { closeMenus(); dd.replaceChildren(...[].concat(build())); m.classList.add("open"); openMenu = m; }
    },
  }, title), dd);
  m.rebuild = () => dd.replaceChildren(...[].concat(build()));
  return m;
}

function item(label, action, opts = {}) {
  return h("button", {
    class: "mitem", disabled: opts.disabled,
    onclick: () => { if (!opts.keep) closeMenus(); action(); if (opts.keep) openMenu?.rebuild(); },
  }, h("span", { class: "check" }, opts.checked === undefined ? "" : opts.checked ? "✓" : ""), label, opts.key ? h("span", { class: "key" }, opts.key) : null);
}
const div = () => h("div", { class: "mdiv" });
const head = (t) => h("div", { class: "mhead" }, t);

function buildMenus() {
  const nav = $("#menus");
  const noDesign = () => !app.design;
  const aid = (k, label) => item(label, () => { app.vo[k] = !app.vo[k]; store("aids", app.vo); app.view.rebuildOverlay(null); }, { checked: app.vo[k], keep: true });
  const onBoard = (k, label) => {
    const look = app.design?.meta.look;
    return item(label, () => setLook(k, !app.design.meta.look[k]), { checked: !!look?.[k], keep: true, disabled: !look });
  };
  const setting = (path, label, on = true, off = false) => item(label, () => {
    setPath(app.cfg, path, getPath(app.cfg, path) === off ? (typeof on === "function" ? on() : on) : off);
    configChanged(path);
  }, { checked: getPath(app.cfg, path) !== off, keep: true });
  nav.replaceChildren(
    menu("File", () => [
      item("Open design…", openDialog, { key: "Ctrl+O" }),
      item("Save", () => saveDesign(), { key: "Ctrl+S", disabled: noDesign() }),
      item("Save as…", saveAs, { disabled: noDesign() }),
      item("Autosave every minute", () => { app.opts.autosave = !app.opts.autosave; store("opts", app.opts); }, { checked: app.opts.autosave, keep: true }),
      div(),
      item("Generate new tiles…", generateDialog),
      div(),
      item("Export board (PDF / SVG / tiles.json)…", exportDialog, { disabled: noDesign(), key: "Ctrl+E" }),
      item("Download design data (JSON)", downloadJSON, { disabled: noDesign() }),
    ]),
    menu("Edit", () => [
      item("Undo" + (app.design?.undoStack.length ? " " + app.design.undoStack.at(-1).label : ""), doUndo, { key: "Ctrl+Z", disabled: !app.design?.undoStack.length }),
      item("Redo" + (app.design?.redoStack.length ? " " + app.design.redoStack.at(-1).label : ""), doRedo, { key: "Ctrl+Y", disabled: !app.design?.redoStack.length }),
      div(),
      item("Merge selected tiles", mergeSelected, { key: "Ctrl+G", disabled: (app.sel.tiles.size < 2) }),
      item("Delete selection", deleteSelection, { key: "Del", disabled: noDesign() }),
      item("Select all tiles", () => select("tiles", app.design.meta.tiles.map((t) => t.id)), { key: "Ctrl+A", disabled: noDesign() }),
      item("Clear selection", () => select(null), { key: "Esc" }),
      div(),
      item("Renumber tiles (west → east in bands)", () => { app.design.renumber(app.cfg); toast("Tiles renumbered"); }, { disabled: noDesign() }),
      item("Recompute all pawn spots", () => { app.design.recomputeAllPawns(app.cfg); toast("Pawn spots recomputed"); }, { disabled: noDesign() }),
      item("Clean up stray tile fragments", () => { const n = app.design.cleanupFragments(); toast(`${n} pixels reassigned`); }, { disabled: noDesign() }),
    ]),
    menu("View", () => [
      item("Fit board", () => app.view.fit(), { key: "0" }),
      item("Zoom in", () => app.view.zoomAt(app.view.cw / 2, app.view.ch / 2, 1.25), { key: "+" }),
      item("Zoom out", () => app.view.zoomAt(app.view.cw / 2, app.view.ch / 2, 0.8), { key: "−" }),
      item("Actual size (approx.)", () => { const b = app.view.toBoard(app.view.cw / 2, app.view.ch / 2); app.view.scale = 96 / 25.4; app.view.centerOn(...b); }),
      div(), head("On the board (also in export)"),
      setting("compose.map_art", "Map image"),
      onBoard("borders", "Tile borders"),
      setting("compose.show_tile_numbers", "Tile numbers"),
      onBoard("circles", "Pawn circles"),
      setting("compose.show_sea_names", "Sea names"),
      onBoard("passages", "Passages"), onBoard("wraps", "Wrap-around arrows"), onBoard("fields", "Fields"),
      ...boardParts().map((b) => item(b.name, b.toggle, { checked: b.shown, keep: true, disabled: noDesign() })),
      div(), head("Tile colour (also in export)"),
      ...[["sea", "By sea"], ["tile", "Every tile different"], ["none", "None (art only)"]].map(([v, l]) =>
        item(l, () => setLook("fill", v), { checked: app.design?.meta.look.fill === v, keep: true, disabled: noDesign() })),
      app.design ? h("div", { class: "mitem", style: "cursor:default" }, h("span", { class: "check" }), "Opacity", opacitySlider()) : null,
      div(), head("Arrows (also in export)"),
      app.design ? h("div", { class: "mitem", style: "cursor:default" }, h("span", { class: "check" }), "Size", arrowSizeSlider("margin-left:auto")) : null,
      app.design ? h("div", { class: "mitem", style: "cursor:default" }, h("span", { class: "check" }), "Colour", arrowColourControl("margin-left:auto")) : null,
      div(), head("Editing aids (screen only)"),
      aid("problems", "Highlight problems"), aid("unassigned", "Show water without a tile"),
    ].filter(Boolean)),
    menu("Generate", () => [
      item("New tiles (new design)…", generateDialog),
      div(), head("Map image for this design"),
      item("Rebuild map image", artJob, { disabled: noDesign() }),
      div(),
      item("Show job log", () => setTab("log")),
      item("Cancel running job", () => postJSON("/api/jobs/cancel"), { disabled: app.job?.status !== "running" }),
    ]),
    menu("Help", () => [item("Keyboard and mouse…", helpDialog), item("About this tool…", aboutDialog)]),
    h("div", { class: "msep" }),
    ...Object.keys(app.cfg).filter((k) => SECTION_TITLES[k]).map((k) => menu(SECTION_TITLES[k], () => configPanel(k), "cfg")),
  );
}

function setLook(key, value) {
  app.design.edit(`view: ${key}`, (m) => { m.look = { ...m.look, [key]: value }; });
}

// one undo step per drag of the slider
function opacitySlider() {
  let d = null;
  return h("input", { type: "range", min: 0, max: 0.9, step: 0.02, value: app.design.meta.look.fill_opacity, style: "margin-left:auto",
    oninput: (e) => {
      if (!d) { d = app.design; d.begin("view: opacity", false); }
      d.meta.look = { ...d.meta.look, fill_opacity: +e.target.value };
      app.view.rebuildOverlay(null);
    },
    onchange: (e) => { d?.commit(); d = null; e.target.blur(); } });
}

// ---------------------------------------------------------------- arrows
function findArrow(key) { return app.design?.analysis?.wraps.find((w) => w.key === key); }

// one undo step per drag of the slider
function arrowSizeSlider(style) {
  let d = null;
  return h("input", { type: "range", min: 0.5, max: 1.8, step: 0.05, value: app.design.meta.look.arrow_size, style, title: "arrow size (1 = standard)",
    oninput: (e) => {
      if (!d) { d = app.design; d.begin("arrow size", false); }
      d.meta.look = { ...d.meta.look, arrow_size: +e.target.value };
      d.analysisVersion = -1;
      d.ensureAnalysis(app.cfg);
      app.view.requestDraw();
    },
    onchange: (e) => { d?.commit(); d = null; e.target.blur(); } });
}

function arrowColourControl(style) {
  const now = app.design.meta.look.arrow_color;
  const input = h("input", { type: "color", value: now || app.cfg.compose.border_color, title: "arrow colour",
    onchange: (e) => { e.target.blur(); setLook("arrow_color", e.target.value); openMenu?.rebuild(); scheduleSidebar(); } });
  const same = h("button", { disabled: !now, title: "follow compose.border_color",
    onclick: () => { setLook("arrow_color", null); openMenu?.rebuild(); scheduleSidebar(); } }, "as borders");
  return h("span", { class: "row", style }, input, same);
}

// ================================================================ config panels
const getPath = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, path, v) {
  const ks = path.split(".");
  let x = o;
  for (const k of ks.slice(0, -1)) x = x[k];
  x[ks.at(-1)] = v;
}
function effectOf(path) {
  if (path.startsWith("art")) return "art";
  if (EDIT_KEYS.includes(path)) return "edit";
  if (path.startsWith("day_track.") && !LIVE_KEYS.includes(path)) return "reset";
  if (LIVE_KEYS.includes(path) || LIVE_PREFIX.some((p) => path === p || path.startsWith(p + "."))) return "live";
  return "regen";
}

let cfgSaveTimer;
async function saveConfig() {
  clearTimeout(cfgSaveTimer);
  // based_on: so that only values changed here are kept, and the rest keeps following the defaults
  await putJSON("/api/config", { config: app.cfg, based_on: app.defaults });
}
function configChanged(path) {
  clearTimeout(cfgSaveTimer);
  cfgSaveTimer = setTimeout(async () => {
    try { await saveConfig(); } catch (e) { toast("Config not saved: " + e.message, true); }
  }, 350);
  applyLiveConfig(path);
}

function applyLiveConfig() {
  const d = app.design;
  checkRegen();
  if (!d) return;
  d.setNoise(app.cfg.tiles);
  updateArt();
  updateFont();
  d.analysisVersion = -1;
  d.ensureAnalysis(app.cfg);
  app.view.rebuildOverlay(null);
  scheduleSidebar();
}

// seas.names_nl only renames: a design that already has those names needs no new tiles
function seasNeedNewTiles(d, now, then) {
  const { names_nl: names = {}, ...rest } = now || {};
  const { names_nl: before = {}, ...was } = then || {};
  if (JSON.stringify(rest) !== JSON.stringify(was)) return true;
  if (JSON.stringify(names) === JSON.stringify(before)) return false;
  return Object.entries(names).some(([name, nl]) => { const sea = d.sea(name); return sea && sea.name_nl !== nl; });
}

function checkRegen() {
  const d = app.design, c = app.cfg;
  let need = false;
  if (d && c) {
    const dc = d.meta.config || {};
    const b = d.board;
    const fr = c.webtool.frame, dfr = b.frame || {};
    need = +c.board.width_mm !== +b.width_mm || +c.board.height_mm !== +b.height_mm ||
      ["top", "right", "bottom", "left"].some((k) => +fr[k] !== +(dfr[k] || 0)) ||
      JSON.stringify(c.map) !== JSON.stringify(dc.map) || seasNeedNewTiles(d, c.seas, dc.seas) ||
      Object.keys(c.tiles).some((k) => effectOf("tiles." + k) === "regen" && JSON.stringify(c.tiles[k]) !== JSON.stringify(dc.tiles?.[k]));
  }
  $("#regen-flag").hidden = !need;
}

function configPanel(section) {
  const val = app.cfg[section];
  const wide = section === "passages";
  const resetBtn = h("button", { onclick: async () => {
    if (section === "passages") { resetPassages(); return; }
    await saveConfig();
    const r = await postJSON("/api/config/reset", { section });
    app.cfg = r.config; app.defaults = r.defaults; applyLiveConfig(); openMenu?.rebuild();
    toast(`${SECTION_TITLES[section]} reset to the defaults`);
  } }, "Reset to defaults");
  const head = h("div", { class: "cfghead" }, h("span", { class: "title" }, SECTION_TITLES[section]), resetBtn);
  const body = h("div", { class: "cfgpanel" + (wide ? " wide" : "") }, head);
  const note = { board: "Changes need new tiles (Generate › New tiles).", map: "Changes need new tiles.",
    seas: "Changes need new tiles.", passages: "Passages are stored in this design. New boards start with the default passages.",
    compose: "Applies at once to the editor and to Export.", day_track: "Each day is a field: click it on the board to edit it. The values below are the defaults for Reset day track.",
    art: "Used by Generate and Generate › Rebuild map image.", webtool: "Frame changes need new tiles (the map shrinks to make room)." }[section];
  if (note) body.append(h("div", { class: "muted", style: "margin-bottom:6px" }, note));
  if (section === "day_track" && app.design) {
    body.append(h("div", { class: "row", style: "margin-bottom:6px" },
      h("button", { onclick: () => { closeMenus(); resetDayTrack(); } }, "Reset day track")));
  }
  if (section === "passages") body.append(passagesTable());
  else renderFields(body, val, section);
  body.addEventListener("pointerdown", (e) => e.stopPropagation());
  return body;
}

function renderFields(parent, obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix + "." + k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      parent.append(h("div", { class: "cfgsub" }, k));
      if (app.comments[path]) parent.append(h("div", { class: "muted", style: "font-size:11px" }, app.comments[path]));
      renderFields(parent, v, path);
      continue;
    }
    parent.append(cfgRow(path, k, v));
  }
}

function cfgRow(path, key, v) {
  const defV = getPath(app.defaults, path);
  const differs = defV !== undefined && JSON.stringify(defV) !== JSON.stringify(v);
  const eff = effectOf(path);
  const set = (nv) => {
    setPath(app.cfg, path, nv);
    configChanged(path);
    const dot = row.querySelector(".diffdot");
    const now = defV !== undefined && JSON.stringify(defV) !== JSON.stringify(nv);
    if (dot) dot.hidden = !now;
  };
  let ctl;
  if (typeof v === "boolean") ctl = h("input", { type: "checkbox", checked: v, onchange: (e) => set(e.target.checked) });
  else if (typeof v === "number") {
    ctl = h("input", { type: "number", value: v, step: Number.isInteger(v) ? 1 : "any",
      oninput: (e) => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) set(Number.isInteger(v) && !e.target.value.includes(".") ? Math.round(n) : n); } });
  } else if (Array.isArray(v)) {
    ctl = h("input", { type: "text", value: v.join(", "), title: "comma separated",
      onchange: (e) => set(e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (/^-?\d+(\.\d+)?$/.test(s) ? +s : s))) });
  } else if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) {
    const txt = h("input", { type: "text", value: v, style: "width:80px" });
    const col = h("input", { type: "color", value: v });
    col.oninput = () => { txt.value = col.value; set(col.value); };
    txt.onchange = () => { if (/^#[0-9a-f]{6}$/i.test(txt.value)) { col.value = txt.value; set(txt.value); } };
    ctl = h("span", { class: "ctl" }, col, txt);
  } else if (typeof v === "string" && v.length > 50) {
    ctl = h("textarea", { rows: 3, onchange: (e) => set(e.target.value) }, v);
  } else if (path === "compose.language") {
    ctl = h("select", { onchange: (e) => set(e.target.value) }, ["en", "nl"].map((o) => h("option", { value: o, selected: o === v }, o)));
  } else if (path === "map.projection") {
    ctl = h("select", { onchange: (e) => set(e.target.value) }, ["miller", "equirectangular"].map((o) => h("option", { value: o, selected: o === v }, o)));
  } else ctl = h("input", { type: "text", value: v ?? "", onchange: (e) => set(e.target.value) });
  const row = h("div", { class: "cfgrow" },
    h("label", { title: path }, key, h("span", { class: "diffdot", hidden: !differs, title: `default: ${JSON.stringify(defV)}` })),
    h("div", { class: "ctl" }, ctl),
    h("span", { class: "badge " + eff, title: { live: "applies immediately, also in export", edit: "shapes tiles that are moved, split or grown from now on", art: "used for the map image", reset: "used when you press Reset day track", regen: "needs new tiles" }[eff] }, { regen: "regenerate", reset: "on reset", edit: "next edit" }[eff] || eff),
    app.comments[path] ? h("div", { class: "help" }, app.comments[path]) : null);
  return row;
}

function resetPassages() {
  const d = app.design;
  if (!d) return;
  d.edit("reset passages", (m) => {
    m.passages = [...app.defaults.passages.map((p) => d.passageFromConfig(p)), ...m.passages.filter((p) => p.source !== "config")];
  });
  openMenu?.rebuild();
  toast("Passages are the defaults again; links drawn here are kept (Ctrl+Z undoes it)");
}

function passagesTable() {
  const d = app.design;
  if (!d) return h("p", { class: "muted" }, "Open a design first.");
  const tbody = h("tbody");
  const ll = (mm) => d.proj.inverse(...mm).map((x) => +x.toFixed(3)).join(", ");
  const parseLL = (s) => { const p = s.split(",").map((x) => parseFloat(x)); return p.length === 2 && p.every((x) => !Number.isNaN(x)) ? p : null; };
  const change = (i, key, value) => { d.edit("edit passage", (m) => { m.passages[i][key] = value; }); };
  const point = (p, i, key) => h("input", { type: "text", value: ll(p[key]), style: "width:120px",
    onchange: (e) => { const v = parseLL(e.target.value); if (v) change(i, key, d.proj.forward(...v)); } });
  const render = () => tbody.replaceChildren(...d.meta.passages.map((p, i) => h("tr", {},
    h("td", {}, h("input", { type: "checkbox", checked: p.enabled !== false, onchange: (e) => change(i, "enabled", e.target.checked) })),
    h("td", {}, h("input", { type: "text", value: p.name, onchange: (e) => change(i, "name", e.target.value) }),
      app.comments["passages." + p.name] ? h("div", { class: "muted", style: "font-size:11px" }, app.comments["passages." + p.name]) : null),
    h("td", {}, h("select", { onchange: (e) => change(i, "kind", e.target.value) },
      ["canal", "strait", "route"].map((k) => h("option", { value: k, selected: p.kind === k }, k)))),
    h("td", {}, point(p, i, "a_mm")),
    h("td", {}, point(p, i, "b_mm")),
    h("td", { class: "muted" }, (p.via_mm || []).length),
    h("td", {}, h("button", { title: "remove", onclick: () => { d.edit("remove passage", (m) => m.passages.splice(i, 1)); render(); } }, "✕")),
  )));
  render();
  return h("div", {},
    h("table", { class: "ptable" }, h("thead", {}, h("tr", {}, ["on", "name", "kind", "a (lon, lat)", "b (lon, lat)", "points", ""].map((t) => h("th", {}, t)))), tbody),
    h("div", { class: "row", style: "margin-top:6px" },
      h("button", { onclick: () => {
        d.edit("add passage", (m) => m.passages.push({ name: "New passage", kind: "strait", enabled: true, source: "manual",
          a_mm: d.proj.forward(0, 0), b_mm: d.proj.forward(1, 1), via_mm: [] }));
        render();
      } }, "+ Add passage"),
      h("span", { class: "muted" }, "To bend one: click it on the map, then drag its line. The Link tool draws new ones.")));
}

// ================================================================ toolbar + option bar
function buildToolbar() {
  const tb = $("#toolbar");
  tb.replaceChildren(...TOOLS.map((t) => (t === "sep" ? h("div", { class: "tsep" }) :
    h("button", { id: "tool-" + t.id, title: `${t.name} (${t.key.toUpperCase()})`, onclick: () => setTool(t.id),
      html: `<svg viewBox="0 0 24 24">${t.icon}</svg><span class="k">${t.key.toUpperCase()}</span>` }))));
}

function setTool(id) {
  app.tool = id;
  app.linkStart = null;
  document.querySelectorAll("#toolbar button").forEach((b) => b.classList.toggle("on", b.id === "tool-" + id));
  buildOptBar();
  updateCursor();
  app.view?.requestDraw();
}

function updateCursor(e) {
  const c = $("#view");
  const t = app.tool;
  c.style.cursor = app.drag?.type === "pan" ? "grabbing" : t === "pan" || app.space ? "grab"
    : t === "paint" || t === "erase" ? "none" : t === "select" ? "default" : "crosshair";
}

function buildOptBar() {
  const o = app.opts, bar = $("#optbar");
  const save = () => store("opts", o);
  const num = (key, attrs, obj = o) => h("input", { type: "number", value: obj[key], ...attrs, oninput: (e) => { obj[key] = +e.target.value; save(); } });
  const chk = (key, label, obj = o) => h("label", {}, h("input", { type: "checkbox", checked: obj[key], onchange: (e) => { obj[key] = e.target.checked; save(); } }), label);
  const t = TOOLS.find((x) => x.id === app.tool);
  const parts = [h("span", { class: "toolname" }, t.name)];
  let hint = "";
  switch (app.tool) {
    case "select":
      hint = "Click a tile · Shift+click adds · drag numbers, sea names, fields and link ends · drag empty space to pan";
      break;
    case "move":
      parts.push(chk("relaxNeighbours", "reshape neighbours"),
        h("label", {}, "scope", h("select", { onchange: (e) => { o.scope = e.target.value; save(); } },
          h("option", { value: "same", selected: o.scope === "same" }, "same sea"), h("option", { value: "all", selected: o.scope === "all" }, "any sea"))),
        h("label", {}, "relax steps", num("iterations", { min: 0, max: 60, style: "width:60px" })));
      hint = "Drag a tile to its new centre; it and its neighbours are regrown (pinned tiles stay)";
      break;
    case "add":
      parts.push(chk("splitNeighbours", "rebalance neighbours"),
        h("label", {}, "relax steps", num("iterations", { min: 0, max: 60, style: "width:60px" })),
        h("label", {}, "new tile area", num("newTileArea", { min: 0, step: 100, style: "width:80px" }), "mm² (0 = average)"));
      hint = "Click inside a tile to split it in two · click water without a tile to grow a new one";
      break;
    case "merge":
      parts.push(h("button", { onclick: mergeSelected }, "Merge selected (Ctrl+G)"));
      hint = "Click tile A, then tile B: B joins A · Shift+click collects tiles, Enter merges them";
      break;
    case "paint":
      parts.push(h("label", {}, "brush", h("input", { type: "range", min: 0.5, max: 25, step: 0.5, value: o.brushMm,
        oninput: (e) => { o.brushMm = +e.target.value; e.target.nextSibling.textContent = o.brushMm + " mm"; save(); } }), h("span", {}, o.brushMm + " mm")),
      chk("protect", "don't paint over other tiles"),
      h("label", {}, "tile", num("lockTile", { min: 0, style: "width:64px", title: "0 = the tile where the stroke starts" }), "(0 = where you start)"));
      hint = "Drag from inside a tile to grow it · Alt+click picks a tile · [ and ] change the brush";
      break;
    case "erase":
      parts.push(h("label", {}, "brush", h("input", { type: "range", min: 0.5, max: 25, step: 0.5, value: o.brushMm,
        oninput: (e) => { o.brushMm = +e.target.value; e.target.nextSibling.textContent = o.brushMm + " mm"; save(); } }), h("span", {}, o.brushMm + " mm")));
      hint = "Erased water is not playable (shown pink with View › Show water without a tile)";
      break;
    case "field": {
      const f = o.field;
      parts.push(
        h("label", {}, "shape", h("select", { onchange: (e) => { f.shape = e.target.value; save(); } },
          ["rect", "rounded", "circle", "hex", "diamond"].map((s) => h("option", { value: s, selected: f.shape === s }, s)))),
        h("label", {}, "w", num("w", { min: 1, style: "width:56px" }, f)), h("label", {}, "h", num("h", { min: 1, style: "width:56px" }, f)),
        h("label", {}, "kind", h("input", { type: "text", value: f.kind, list: "kinds", style: "width:90px", onchange: (e) => { f.kind = e.target.value; save(); } })),
        h("label", {}, h("input", { type: "color", value: f.color, oninput: (e) => { f.color = e.target.value; save(); } })),
        h("button", { onclick: () => setTab("fields") }, "Edge track…"));
      hint = "Click to place a field · drag to move (snaps to the grid and board edges) · arrows nudge";
      break;
    }
    case "link":
      parts.push(h("label", {}, "kind", h("select", { onchange: (e) => { o.linkKind = e.target.value; save(); } },
        ["canal", "strait", "route"].map((k) => h("option", { value: k, selected: o.linkKind === k }, k)))));
      hint = "Click a point in one tile, then a point in another · Esc cancels";
      break;
    case "pan":
      hint = "Drag to pan · wheel to zoom · 0 fits the board";
      break;
  }
  parts.push(h("span", { class: "hint" }, hint));
  bar.replaceChildren(...parts, h("datalist", { id: "kinds" }, FIELD_KINDS.map((k) => h("option", { value: k }))));
}

// ================================================================ canvas interaction
function pointerInfo(e) {
  const r = $("#view").getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const d = app.design;
  const [bx, by] = app.view.toBoard(sx, sy);
  if (!d) return { sx, sy, bx, by };
  const [mx, my] = d.boardToMap(bx, by);
  const [c, r2] = d.mapToPx(mx, my);
  const inMap = c >= 0 && r2 >= 0 && c < d.W && r2 < d.H;
  return { sx, sy, bx, by, mx, my, c, r: r2, inMap, id: inMap ? d.idAt(c, r2) : 0 };
}

function snapField(f) {
  const d = app.design, s = +app.cfg.webtool.snap_mm || 0;
  if (s > 0) { f.x = Math.round(f.x / s) * s; f.y = Math.round(f.y / s) * s; }
  const th = 3, W = d.board.width_mm, H = d.board.height_mm;
  const hw = f.w / 2, hh = f.h / 2;
  const rot = Math.abs(((f.rotation || 0) % 180)) === 90;
  const ex = rot ? hh : hw, ey = rot ? hw : hh;
  if (Math.abs(f.x - ex) < th) f.x = ex;
  if (Math.abs(W - f.x - ex) < th) f.x = W - ex;
  if (Math.abs(f.y - ey) < th) f.y = ey;
  if (Math.abs(H - f.y - ey) < th) f.y = H - ey;
  f.x = round2(f.x); f.y = round2(f.y);
}

function hitTest(p) {
  const d = app.design, look = d.meta.look, c = app.cfg.compose, sel = app.sel.passage;
  if (look.fields) for (let i = d.meta.fields.length - 1; i >= 0; i--) if (fieldHit(d.meta.fields[i], p.bx, p.by)) return { type: "field", f: d.meta.fields[i] };
  const near = (q, mm) => Math.hypot(q[0] - p.mx, q[1] - p.my) < mm;
  const routes = look.passages
    ? (d.analysis?.passageInfo || []).filter((pi) => pi.p === sel || (pi.p.enabled && pi.status === "ok" && pi.drawn)).map((pi) => pi.p) : [];
  if (sel && routes.includes(sel)) {
    const via = sel.via_mm || [], grab = Math.max(0.8, Math.min(2, 6 / app.view.scale));
    for (let i = 0; i < via.length; i++) if (near(via[i], grab)) return { type: "waypoint", p: sel, i };
  }
  for (const pa of routes) {
    // ends can be dragged at once on drawn links, on the others after selecting them
    if (pa !== sel && pa.source === "config") continue;
    for (const end of ["a_mm", "b_mm"]) if (near(pa[end], pa === sel ? 1.6 : 2)) return { type: "passageEnd", p: pa, end };
  }
  // an arrow's point goes before numbers and names, the number beside it after the pawn spots
  let arrow = null;
  const slack = Math.min(1.5, 3 / app.view.scale);
  for (const w of d.analysis?.wraps || []) {
    if (app.sel.arrow !== w.key && (!look.wraps || w.hidden || w.closed)) continue;
    const part = arrowPart(w, p.mx, p.my, d.board.inner_width_mm, look.arrow_size, slack);
    if (!part) continue;
    const off = Math.abs(w.y_mm - p.my);
    if (!arrow || (part === "point" && arrow.part !== "point") || (part === arrow.part && off < arrow.off)) arrow = { type: "arrow", w, part, off };
  }
  if (arrow?.part === "point") return arrow;
  if (c.show_sea_names) for (const lb of app.view.labelBoxes) if (p.mx >= lb.x && p.mx <= lb.x + lb.w && p.my >= lb.y && p.my <= lb.y + lb.h) return { type: "label", sea: lb.sea };
  if (c.show_tile_numbers || look.circles) {
    const r = Math.min(5, (app.cfg.tiles.pawn_diameter_mm || 12) / 2);
    for (const t of d.meta.tiles) if (t.pawn_mm && near(t.pawn_mm, r * 0.6)) return { type: "pawn", t };
  }
  if (arrow) return arrow;
  for (const pa of routes) {
    const pts = passagePoints(pa);
    for (let i = 0; i < pts.length - 1; i++) if (segDist(p.mx, p.my, pts[i], pts[i + 1]) < 1.2) return { type: "passage", p: pa, segment: i };
  }
  if (p.id) return { type: "tile", id: p.id };
  return null;
}
function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

function bindCanvas() {
  const cv = $("#view");
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = pointerInfo(e);
    app.view.zoomAt(p.sx, p.sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    updateZoom();
  }, { passive: false });
  cv.addEventListener("pointerdown", onDown);
  cv.addEventListener("pointermove", onMove);
  cv.addEventListener("pointerup", onUp);
  cv.addEventListener("pointercancel", onUp);
  cv.addEventListener("pointerleave", () => { app.hoverBoard = null; app.view.requestDraw(); });
}

function startPan(p) { app.drag = { type: "pan", sx: p.sx, sy: p.sy, tx: app.view.tx, ty: app.view.ty }; updateCursor(); }

function onDown(e) {
  // commit what is being typed first; its change event would otherwise end the drag's undo step
  if (document.activeElement !== document.body) document.activeElement?.blur();
  const d = app.design;
  const p = pointerInfo(e);
  $("#view").setPointerCapture(e.pointerId);
  if (!d || e.button === 1 || e.button === 2 || app.space || app.tool === "pan") { startPan(p); return; }
  if (e.button !== 0) return;
  switch (app.tool) {
    case "select": {
      const hit = hitTest(p);
      if (!hit) { select(null); startPan(p); return; }
      if (hit.type === "field") {
        select("field", hit.f.id);
        d.begin("move field", false);
        app.drag = { type: "field", id: hit.f.id, ox: hit.f.x - p.bx, oy: hit.f.y - p.by, moved: false };
      } else if (hit.type === "arrow") {
        select("arrow", hit.w.key);
        d.begin("move arrow", false);
        app.drag = { type: "arrow", key: hit.w.key, oy: hit.w.y_mm - p.my, start: [p.sx, p.sy], moved: false };
      } else if (hit.type === "label") {
        select("sea", hit.sea);
        d.begin("move sea name", false);
        const s = d.sea(hit.sea);
        app.drag = { type: "label", sea: hit.sea, ox: s.label_mm[0] - p.mx, oy: s.label_mm[1] - p.my, moved: false };
      } else if (hit.type === "pawn") {
        select("tiles", hit.t.id, e.shiftKey);
        d.begin("move pawn spot", false);
        app.drag = { type: "pawn", id: hit.t.id, moved: false };
      } else if (hit.type === "passageEnd") {
        select("passage", hit.p);
        d.begin("move link end", false);
        app.drag = { type: "passageEnd", p: hit.p, end: hit.end, moved: false };
      } else if (hit.type === "waypoint") {
        if (e.altKey) { d.edit("remove waypoint", () => hit.p.via_mm.splice(hit.i, 1)); refreshSidebar(); return; }
        d.begin("move waypoint", false);
        app.drag = { type: "waypoint", p: hit.p, i: hit.i, moved: false };
      } else if (hit.type === "passage") {
        // a selected passage bends where its line is dragged
        if (app.sel.passage === hit.p) {
          d.begin("add waypoint", false);
          app.drag = { type: "bend", p: hit.p, i: hit.segment, start: [p.sx, p.sy], moved: false };
        } else select("passage", hit.p);
      } else if (hit.type === "tile") {
        select("tiles", hit.id, e.shiftKey);
        startPan(p);
        app.drag.click = true;
      }
      break;
    }
    case "move":
      if (!p.id) { toast("Start the drag inside a tile"); return; }
      if (d.tile(p.id)?.pinned) { toast(`Tile ${p.id} is pinned (unpin it in the inspector)`); return; }
      select("tiles", p.id);
      app.drag = { type: "moveTile", id: p.id, cur: [p.mx, p.my], start: [p.sx, p.sy] };
      break;
    case "add": {
      if (!p.inMap) return;
      busy(() => {
        if (p.id) {
          const nid = d.splitAt(p.c, p.r, { relaxNeighbours: app.opts.splitNeighbours, iterations: app.opts.iterations }, app.cfg);
          if (nid) { select("tiles", [p.id, nid]); toast(`Tile ${p.id} split; new tile ${nid}`); }
        } else if (d.water[p.r * d.W + p.c]) {
          const r = d.growAt(p.c, p.r, { newTileArea: app.opts.newTileArea }, app.cfg);
          if (r) {
            select("tiles", r.id);
            toast(r.count < r.targetPx * 0.5 ? `New tile ${r.id} is small: only ${fmt(r.count / d.ppm / d.ppm, 0)} mm² of free water here` : `New tile ${r.id} (${d.tile(r.id).sea})`, r.count < r.targetPx * 0.5);
          }
        } else toast("That is land: click in water");
      });
      break;
    }
    case "merge": {
      if (!p.id) return;
      if (e.shiftKey || app.sel.tiles.size !== 1 || app.sel.tiles.has(p.id)) { select("tiles", p.id, e.shiftKey); return; }
      const keep = [...app.sel.tiles][0];
      d.merge([keep, p.id]);
      select("tiles", keep);
      toast(`Tile ${p.id} merged into ${keep}`);
      break;
    }
    case "paint":
    case "erase": {
      if (!p.inMap) return;
      if (app.tool === "paint" && e.altKey) { if (p.id) { app.opts.lockTile = p.id; store("opts", app.opts); buildOptBar(); toast(`Brush paints tile ${p.id}`); } return; }
      let value = 0;
      if (app.tool === "paint") {
        value = app.opts.lockTile && d.tile(app.opts.lockTile) ? app.opts.lockTile : p.id;
        if (!value) { toast("Start inside the tile you want to grow (or Alt+click a tile)"); return; }
        select("tiles", value);
      }
      d.beginStroke(value, app.tool === "paint" && app.opts.protect);
      app.drag = { type: "stroke" };
      const rect = d.strokeTo(p.c, p.r, app.opts.brushMm * d.ppm);
      if (rect) app.view.rebuildOverlay(rect);
      break;
    }
    case "field": {
      const hit = d.meta.fields.slice().reverse().find((f) => fieldHit(f, p.bx, p.by));
      d.begin(hit ? "move field" : "add field", false);
      let f = hit;
      if (!f) {
        const t = app.opts.field;
        const n = d.meta.fields.filter((x) => x.kind === t.kind).length + 1;
        f = { id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind: t.kind, label: t.label || String(n),
          shape: t.shape, x: p.bx, y: p.by, w: t.w, h: t.h, rotation: 0, color: t.color, opacity: 1, notes: "", group: null };
        snapField(f);
        d.meta.fields.push(f);
      }
      select("field", f.id);
      app.drag = { type: "field", id: f.id, ox: f.x - p.bx, oy: f.y - p.by, moved: !hit };
      break;
    }
    case "link": {
      if (!p.inMap) return;
      if (!app.linkStart) { app.linkStart = [p.mx, p.my]; toast("Now click the other end"); app.view.requestDraw(); return; }
      const a = app.linkStart;
      app.linkStart = null;
      const ta = d.tileNear(a[0], a[1]), tb = d.tileNear(p.mx, p.my);
      d.edit("add link", (m) => m.passages.push({ name: `Link ${ta || "?"}–${tb || "?"}`, kind: app.opts.linkKind, enabled: true,
        source: "manual", a_mm: a.map(round2), b_mm: [round2(p.mx), round2(p.my)], via_mm: [] }));
      d.analysisVersion = -1; d.ensureAnalysis(app.cfg);
      select("passage", d.meta.passages.at(-1));
      toast(ta && tb && ta !== tb ? `Link between tiles ${ta} and ${tb}` : "Link added, but an end is not in a tile", !(ta && tb && ta !== tb));
      break;
    }
  }
}

function onMove(e) {
  const p = pointerInfo(e);
  const d = app.design;
  app.hoverBoard = [p.bx, p.by];
  app.hoverMap = d ? [p.mx, p.my] : null;
  updateStatus(p);
  const g = app.drag;
  if (!g) { if (app.tool === "paint" || app.tool === "erase" || app.linkStart) app.view.requestDraw(); return; }
  switch (g.type) {
    case "pan":
      if (Math.hypot(p.sx - g.sx, p.sy - g.sy) > 3) g.click = false;
      app.view.tx = g.tx + p.sx - g.sx; app.view.ty = g.ty + p.sy - g.sy; app.view.requestDraw();
      break;
    case "field": {
      const f = d.meta.fields.find((x) => x.id === g.id);
      f.x = p.bx + g.ox; f.y = p.by + g.oy; snapField(f); g.moved = true; app.view.requestDraw();
      break;
    }
    case "label": d.sea(g.sea).label_mm = [round2(p.mx + g.ox), round2(p.my + g.oy)]; g.moved = true; app.view.requestDraw(); break;
    case "pawn": {
      const t = d.tile(g.id);
      t.pawn_mm = [round2(p.mx), round2(p.my)]; t.pawn_manual = true; g.moved = true; app.view.requestDraw();
      break;
    }
    case "passageEnd": g.p[g.end] = [round2(p.mx), round2(p.my)]; g.moved = true; app.view.requestDraw(); break;
    case "arrow": {
      if (!g.moved && Math.hypot(p.sx - g.start[0], p.sy - g.start[1]) < 3) break;
      const w = findArrow(g.key);
      if (!w) break;
      w.y_mm = d.arrowSpotFor(w, p.my + g.oy);
      d.meta.arrows = { ...d.meta.arrows, [g.key]: { ...d.meta.arrows[g.key], y_mm: w.y_mm } };
      g.moved = true; app.view.requestDraw();
      break;
    }
    case "bend":
      if (Math.hypot(p.sx - g.start[0], p.sy - g.start[1]) < 3) break;
      (g.p.via_mm ||= []).splice(g.i, 0, [round2(p.mx), round2(p.my)]);
      g.type = "waypoint"; g.moved = true; app.view.requestDraw();
      break;
    case "waypoint": g.p.via_mm[g.i] = [round2(p.mx), round2(p.my)]; g.moved = true; app.view.requestDraw(); break;
    case "moveTile": g.cur = [p.mx, p.my]; app.view.requestDraw(); break;
    case "stroke": {
      const rect = d.strokeTo(p.c, p.r, app.opts.brushMm * d.ppm);
      if (rect) {
        app.view.rebuildOverlay(rect);
        if (performance.now() - (g.traced || 0) > 120) { d.traceBorders(); g.traced = performance.now(); }
      }
      app.view.requestDraw();
      break;
    }
  }
}

function onUp(e) {
  const g = app.drag;
  app.drag = null;
  updateCursor();
  const d = app.design;
  if (!g || !d) return;
  const p = pointerInfo(e);
  switch (g.type) {
    case "field": case "label": case "pawn": case "passageEnd": case "waypoint": case "bend": case "arrow":
      if (g.moved) { d.commit(); if (g.type !== "field" && g.type !== "label") d.ensureAnalysis(app.cfg); refreshSidebar(); }
      else d.cancel();
      app.view.requestDraw();
      break;
    case "moveTile": {
      if (Math.hypot(p.sx - g.start[0], p.sy - g.start[1]) < 4) { app.view.requestDraw(); break; }
      const [c, r] = d.mapToPx(...g.cur);
      busy(() => {
        const ids = d.moveTile(g.id, Math.max(0, Math.min(d.W - 1, c)), Math.max(0, Math.min(d.H - 1, r)),
          { relaxNeighbours: app.opts.relaxNeighbours, scope: app.opts.scope, iterations: app.opts.iterations }, app.cfg);
        toast(`Tile ${g.id} moved (${ids.length} tiles regrown)`);
      });
      break;
    }
    case "stroke":
      d.endStroke();
      d.bordersKey = null;      // also when the stroke changed nothing in the end
      d.analysisVersion = -1;
      clearTimeout(analysisTimer);
      analysisTimer = setTimeout(runAnalysis, 120);
      break;
  }
}

function busy(fn) {
  $("#st-msg").textContent = "working…";
  document.body.style.cursor = "progress";
  setTimeout(() => {
    try { fn(); } catch (err) { console.error(err); toast(err.message, true); }
    document.body.style.cursor = "";
  }, 10);
}

function updateStatus(p) {
  const d = app.design;
  $("#st-pos").textContent = `${fmt(p.bx)}, ${fmt(p.by)} mm`;
  if (!d || !p.inMap) { $("#st-tile").textContent = ""; return; }
  const [lon, lat] = d.proj.inverse(p.mx, p.my);
  let s = `${fmt(Math.abs(lat))}°${lat >= 0 ? "N" : "S"} ${fmt(Math.abs(lon))}°${lon >= 0 ? "E" : "W"}`;
  if (p.id) {
    const t = d.tile(p.id), a = d.analysis;
    s += ` · tile ${p.id}${t ? " · " + t.sea : ""}${a ? ` · ${fmt(a.area[p.id] / d.ppm / d.ppm, 0)} mm²` : ""}`;
  } else s += d.water[p.r * d.W + p.c] ? " · water without tile" : " · land";
  $("#st-tile").textContent = s;
}
function updateZoom() { $("#st-zoom").textContent = `${fmt(app.view.scale / (96 / 25.4) * 100, 0)} %`; }

// ================================================================ commands
function doUndo() { history("undo", "Undo: "); }
function doRedo() { history("redo", "Redo: "); }
function history(step, word) {
  const d = app.design;
  if (!d || app.drag) return;
  // undo replaces the objects: find the selected passage again by its place
  const i = app.sel.passage ? d.meta.passages.indexOf(app.sel.passage) : -1, name = app.sel.passage?.name;
  const label = d[step]();
  if (!label) return;
  if (i >= 0 && d.meta.passages[i]?.name === name) app.sel.passage = d.meta.passages[i];
  d.ensureAnalysis(app.cfg);
  app.view.requestDraw();
  toast(word + label);
}
function mergeSelected() {
  const ids = [...app.sel.tiles];
  if (ids.length < 2) { toast("Select two or more tiles first (Shift+click)"); return; }
  const keep = app.design.merge(ids);
  select("tiles", keep);
  toast(`Merged into tile ${keep}`);
}
async function deleteSelection() {
  const d = app.design;
  if (!d) return;
  if (app.sel.field) {
    const id = app.sel.field;
    d.edit("delete field", (m) => { m.fields = m.fields.filter((f) => f.id !== id); });
    select(null);
  } else if (app.sel.arrow) {
    d.editArrow("hide arrow", app.sel.arrow, { hidden: true });
    d.ensureAnalysis(app.cfg);
    refreshSidebar();
    toast("Arrow hidden. The crossing still connects; 'Close crossing' in Inspect ends that.");
  } else if (app.sel.passage) {
    const p = app.sel.passage;
    d.edit("delete link", (m) => { m.passages = m.passages.filter((x) => x !== p); });
    select(null);
  } else if (app.sel.tiles.size) {
    const ids = [...app.sel.tiles];
    if (!(await confirmBox("Delete tiles", `Delete tile${ids.length > 1 ? "s" : ""} ${ids.join(", ")}? The water becomes unplayable (use Merge to give it to a neighbour instead).`, "Delete", true))) return;
    d.deleteTiles(ids);
    select(null);
  }
}

// to the next spot at least `mm` away in that direction, else as far as the edge goes
function nudgeArrow(dir, mm) {
  const d = app.design, w = findArrow(app.sel.arrow);
  if (!w) return;
  const ahead = d.arrowSpotsFor(w).filter((v) => (v - w.y_mm) * dir > 0.001);
  if (dir < 0) ahead.reverse();
  if (!ahead.length) { toast("The arrow is at the end of the edge these tiles share"); return; }
  const y = ahead.find((v) => (v - w.y_mm) * dir >= mm - 0.01) ?? ahead[ahead.length - 1];
  d.editArrow("move arrow", w.key, { y_mm: y });
  d.ensureAnalysis(app.cfg);
  app.view.requestDraw();
  refreshSidebar();
}

function bindKeys() {
  window.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveDesign(); return; }
    if (typing || $("#dialog").open) return;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); doRedo(); }
      else if (k === "g") { e.preventDefault(); mergeSelected(); }
      else if (k === "o") { e.preventDefault(); openDialog(); }
      else if (k === "e") { e.preventDefault(); exportDialog(); }
      else if (k === "a" && app.design) { e.preventDefault(); select("tiles", app.design.meta.tiles.map((t) => t.id)); }
      else if (k === "d" && app.sel.field) { e.preventDefault(); duplicateField(); }
      return;
    }
    if (e.key === " ") { app.space = true; updateCursor(); e.preventDefault(); return; }
    if (e.key === "Escape") { app.linkStart = null; closeMenus(); select(null); return; }
    if (e.key === "Delete" || e.key === "Backspace") { deleteSelection(); return; }
    if (e.key === "Enter" && app.tool === "merge") { mergeSelected(); return; }
    if (e.key === "0") { app.view.fit(); updateZoom(); return; }
    if (e.key === "+" || e.key === "=") { app.view.zoomAt(app.view.cw / 2, app.view.ch / 2, 1.25); updateZoom(); return; }
    if (e.key === "-") { app.view.zoomAt(app.view.cw / 2, app.view.ch / 2, 0.8); updateZoom(); return; }
    if (e.key === "[" || e.key === "]") {
      app.opts.brushMm = Math.max(0.5, Math.min(25, app.opts.brushMm * (e.key === "]" ? 1.25 : 0.8)));
      app.opts.brushMm = Math.round(app.opts.brushMm * 2) / 2;
      store("opts", app.opts); buildOptBar(); app.view.requestDraw(); return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && app.sel.arrow && app.design) {
      e.preventDefault();
      if (!app.drag) nudgeArrow(e.key === "ArrowUp" ? -1 : 1, e.shiftKey ? 5 : 1);
      return;
    }
    if (e.key.startsWith("Arrow") && app.sel.field && app.design) {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      app.design.edit("nudge field", (m) => { const f = m.fields.find((x) => x.id === app.sel.field); f.x = round2(f.x + dx); f.y = round2(f.y + dy); });
      refreshSidebar();
      return;
    }
    const t = TOOLS.find((x) => x !== "sep" && x.key === e.key.toLowerCase());
    if (t) setTool(t.id);
  });
  window.addEventListener("keyup", (e) => { if (e.key === " ") { app.space = false; updateCursor(); } });
}

// ================================================================ sidebar
const TABS = [["inspect", "Inspect"], ["seas", "Seas"], ["fields", "Fields"], ["report", "Report"], ["log", "Log"]];
function buildTabs() {
  $("#tabs").replaceChildren(...TABS.map(([id, label]) => h("button", { id: "tab-" + id, onclick: () => setTab(id) }, label)));
  setTab(app.tab);
}
function setTab(id, noRender) {
  app.tab = id;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.id === "tab-" + id));
  if (!noRender) refreshSidebar();
}
let sidebarTimer;
function scheduleSidebar() { clearTimeout(sidebarTimer); sidebarTimer = setTimeout(refreshSidebar, 150); }
function refreshSidebar() {
  const body = $("#tabbody");
  const active = document.activeElement;
  if (active && body.contains(active) && /input|textarea|select/i.test(active.tagName)) return;  // don't disturb typing
  const scroll = body.scrollTop;
  const fn = { inspect: renderInspect, seas: renderSeas, fields: renderFieldsTab, report: renderReport, log: renderLog }[app.tab];
  body.replaceChildren(...[].concat(fn() || []));
  body.scrollTop = scroll;
  updateDocInfo();
}

function tileChip(id, warn) {
  return h("span", { class: "chip" + (warn ? " warn" : ""), onclick: () => focusTile(id) }, id);
}
function focusTile(id) {
  const d = app.design, t = d.tile(id);
  select("tiles", id);
  if (t?.pawn_mm) app.view.centerOn(...d.mapToBoard(...t.pawn_mm), app.view.scale);
}

function seaSelect(value, onchange) {
  const d = app.design;
  return h("select", { onchange: async (e) => {
    if (e.target.value === "__new") {
      const name = await promptBox("New sea", "Name", "");
      if (!name) { e.target.value = value; return; }
      if (!d.sea(name)) d.edit("add sea", (m) => m.seas.push({ name, name_nl: name, class: "sea", color: randomColour(), label_mm: null, label_size_mm: null, show_label: true }));
      onchange(name);
    } else onchange(e.target.value);
  } }, d.meta.seas.map((s) => h("option", { value: s.name, selected: s.name === value }, s.name)),
  h("option", { value: "__new" }, "+ new sea…"));
}
function randomColour() { const hue = Math.random(); const c = [0, 8, 4].map((n) => { const k = (n + hue * 12) % 12; return Math.round((0.62 - 0.45 * 0.38 * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255); }); return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join(""); }

function renderInspect() {
  const d = app.design;
  if (!d) return h("p", { class: "muted" }, "No design open.");
  const a = d.analysis;
  const pawn = app.cfg.tiles.pawn_diameter_mm;
  if (app.sel.field) return fieldInspector(d.meta.fields.find((f) => f.id === app.sel.field));
  if (app.sel.passage) return passageInspector(app.sel.passage);
  if (app.sel.arrow) return arrowInspector(app.sel.arrow);
  const ids = [...app.sel.tiles];
  if (ids.length > 1) {
    const total = ids.reduce((s, id) => s + (a ? a.area[id] : 0), 0) / d.ppm / d.ppm;
    return [h("div", { class: "sec" }, h("h3", {}, `${ids.length} tiles selected`),
      h("div", { class: "chips" }, ids.map((id) => tileChip(id))),
      h("p", { class: "muted" }, `Together ${fmt(total, 0)} mm²`)),
    h("div", { class: "sec" }, h("h3", {}, "Actions"),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: mergeSelected }, "Merge into " + ids[0]),
        h("button", { class: "danger", onclick: deleteSelection }, "Delete")),
      h("div", { class: "kv", style: "margin-top:8px" }, h("label", {}, "Set sea"),
        seaSelect(d.tile(ids[0])?.sea, (name) => d.edit("set sea", () => ids.forEach((id) => { const t = d.tile(id); if (t) t.sea = name; })))))];
  }
  if (ids.length === 1) {
    const id = ids[0], t = d.tile(id);
    if (!t) return h("p", { class: "muted" }, `Tile ${id} has no data.`);
    const insc = a ? (a.inscribedPx[id] * 2) / d.ppm : null;
    const nb = a?.graph?.get(id) || new Map();
    const fits = insc != null && insc >= pawn;
    return [
      h("div", { class: "sec" }, h("h3", {}, `Tile ${id}`),
        h("div", { class: "kv" },
          h("label", {}, "Sea"), seaSelect(t.sea, (name) => d.edit(`tile ${id} sea`, () => { d.tile(id).sea = name; })),
          h("span", {}, "Area"), h("span", {}, a ? `${fmt(a.area[id] / d.ppm / d.ppm, 0)} mm²` : "–"),
          h("span", {}, "Widest circle"), h("span", { class: fits ? "good" : "warn" }, `${fmt(insc)} mm ${fits ? "✓" : `✗ pawn ${pawn} mm does not fit`}`),
          h("span", {}, "Pieces"), h("span", { class: a?.pieces[id] > 1 ? "warn" : "" }, a ? String(a.pieces[id]) + (a.pieces[id] > 1 ? " (Edit › Clean up fragments)" : "") : "–"),
          h("span", {}, "Pawn spot"), h("span", {}, t.pawn_mm ? `${fmt(t.pawn_mm[0])}, ${fmt(t.pawn_mm[1])}${t.pawn_manual ? " (by hand)" : ""}` : "–"),
          h("label", {}, "Pinned"), h("label", {}, h("input", { type: "checkbox", checked: !!t.pinned, onchange: (e) => d.edit(`pin ${id}`, () => { d.tile(id).pinned = e.target.checked; }) }), " keep shape when neighbours move"))),
      h("div", { class: "sec" }, h("h3", {}, `Neighbours (${nb.size})`),
        h("div", { class: "chips" }, [...nb.entries()].sort((x, y) => x[0] - y[0]).map(([o, kind]) =>
          h("span", { class: "chip", onclick: () => focusTile(o), title: kind }, o, kind !== "sea" ? h("span", { class: "chip kind", style: "border:none;padding:0 0 0 4px" }, kind) : null)))),
      h("div", { class: "sec" }, h("h3", {}, "Note (game use)"),
        h("textarea", { rows: 3, placeholder: "e.g. harbour, storm zone, start tile…", onchange: (e) => d.edit(`note ${id}`, () => { d.tile(id).note = e.target.value; }) }, t.note || "")),
      h("div", { class: "sec" }, h("h3", {}, "Actions"), h("div", { class: "row" },
        h("button", { onclick: () => { setTool("merge"); toast(`Now click the tile to merge into ${id}`); } }, "Merge with…"),
        h("button", { onclick: () => { d.edit(`pawn ${id} auto`, () => { d.tile(id).pawn_manual = false; }); d.pendingAffected.add(id); d.analysisVersion = -1; d.ensureAnalysis(app.cfg); app.view.requestDraw(); } }, "Auto pawn spot"),
        h("button", { onclick: () => { app.opts.lockTile = id; store("opts", app.opts); setTool("paint"); } }, "Paint this tile"),
        h("button", { class: "danger", onclick: deleteSelection }, "Delete"))),
    ];
  }
  if (app.sel.sea) { setTab("seas", true); return renderSeas(); }
  return [h("div", { class: "sec" }, h("h3", {}, "Nothing selected"),
    h("p", { class: "muted" }, "Click a tile, a field, a sea name or a passage. The Report tab lists problems; the menubar on the right holds every config.yaml setting.")),
  summaryStats()];
}

function summaryStats() {
  const d = app.design, a = d.analysis;
  if (!a) return null;
  const areas = d.meta.tiles.map((t) => a.area[t.id] / d.ppm / d.ppm).filter((x) => x > 0);
  const mean = areas.reduce((s, x) => s + x, 0) / (areas.length || 1);
  const cv = Math.sqrt(areas.reduce((s, x) => s + (x - mean) ** 2, 0) / (areas.length || 1)) / mean;
  return h("div", { class: "stat" },
    h("div", {}, h("b", {}, d.meta.tiles.length), h("span", {}, "tiles")),
    h("div", {}, h("b", {}, fmt(mean, 0)), h("span", {}, "mean mm²")),
    h("div", {}, h("b", {}, fmt(cv * 100, 0) + "%"), h("span", {}, "size spread")),
    h("div", {}, h("b", {}, new Set(d.meta.tiles.map((t) => t.sea)).size), h("span", {}, "seas used")),
    h("div", {}, h("b", {}, d.meta.fields.length), h("span", {}, "fields")),
    h("div", {}, h("b", {}, a.passageInfo?.filter((p) => p.status === "ok").length ?? 0), h("span", {}, "passages")));
}

function fieldInspector(f) {
  const d = app.design;
  if (!f) return null;
  const set = (k, v) => {
    if (!d.meta.fields.some((y) => y.id === f.id)) return;
    d.edit("edit field", (m) => { m.fields.find((y) => y.id === f.id)[k] = v; });
    app.view.requestDraw();
  };
  const numIn = (k, step = 1) => h("input", { type: "number", value: f[k] ?? "", step, onchange: (e) => {
    const raw = e.target.value, needed = ["x", "y", "w", "h"].includes(k);
    if (needed && raw === "") { e.target.value = f[k]; return; }
    const v = raw === "" ? null : k === "w" || k === "h" ? Math.max(1, +raw) : +raw;
    if (v !== null) e.target.value = v;
    set(k, v);
  } });
  const names = fieldLabels(f, boardText(app));
  const isLegend = f.shape === "legend";
  return [h("div", { class: "sec" }, h("h3", {}, `Field · ${f.kind || "field"}`),
    h("div", { class: "formgrid" },
      h("label", {}, "On board"), h("label", {}, h("input", { type: "checkbox", checked: !f.hidden,
        onchange: (e) => { e.target.blur(); set("hidden", !e.target.checked); } }), " show, also in export"),
      ...(isLegend ? [] : [
        h("label", {}, "Kind"), h("input", { type: "text", value: f.kind || "", list: "kinds", onchange: (e) => set("kind", e.target.value) }),
        h("label", {}, "Label"), h("textarea", { rows: 2, onchange: (e) => set("label", e.target.value) }, names.label),
        h("label", {}, "Small text"), h("input", { type: "text", value: names.sub, onchange: (e) => set("sublabel", e.target.value) }),
        h("label", {}, "Shape"), h("select", { onchange: (e) => set("shape", e.target.value) }, ["rect", "rounded", "circle", "hex", "diamond"].map((s) => h("option", { value: s, selected: f.shape === s }, s))),
      ]),
      h("label", {}, "x / y (mm)"), h("div", { class: "row" }, numIn("x", 0.5), numIn("y", 0.5)),
      h("label", {}, "w / h (mm)"), h("div", { class: "row" }, numIn("w", 0.5), numIn("h", 0.5)),
      h("label", {}, "Rotation °"), numIn("rotation", 15),
      h("label", {}, isLegend ? "Opacity" : "Fill"), h("div", { class: "row" },
        isLegend ? null : h("input", { type: "color", value: f.color || "#c8743a", onchange: (e) => set("color", e.target.value) }),
        h("input", { type: "range", min: 0, max: 1, step: 0.05, value: f.opacity ?? 1, title: "opacity", onchange: (e) => set("opacity", +e.target.value) })),
      h("label", {}, "Text colour"), h("input", { type: "color", value: f.text_color || app.cfg.compose.border_color, onchange: (e) => set("text_color", e.target.value) }),
      ...(isLegend ? [] : [h("label", {}, "Font (mm)"), numIn("font_mm", 0.5)]),
      h("label", {}, "Group"), h("span", { class: "muted" }, f.group || "–"),
      h("label", {}, "Notes"), h("textarea", { rows: 3, placeholder: "what this space is for (game rules later)", onchange: (e) => set("notes", e.target.value) }, f.notes || ""))),
  h("div", { class: "row" }, h("button", { onclick: duplicateField }, "Duplicate (Ctrl+D)"),
    f.group ? h("button", { onclick: () => { d.edit("delete group", (m) => { m.fields = m.fields.filter((x) => x.group !== f.group); }); select(null); } }, "Delete group") : null,
    h("button", { class: "danger", onclick: deleteSelection }, "Delete"))];
}

function duplicateField() {
  const d = app.design;
  const f = d.meta.fields.find((x) => x.id === app.sel.field);
  if (!f) return;
  const nf = { ...clone(f), id: "f" + Date.now().toString(36), x: f.x + f.w + 2, group: null };
  snapField(nf);
  d.edit("duplicate field", (m) => m.fields.push(nf));
  select("field", nf.id);
}

function passageInspector(p) {
  const d = app.design;
  const info = d.analysis?.passageInfo?.find((x) => x.p === p);
  const main = app.defaults.passages.find((m) => m.name === p.name);
  const via = p.via_mm || [];
  const apply = (label, fn) => {
    if (!d.meta.passages.includes(p)) return;
    d.edit(label, fn);
    d.ensureAnalysis(app.cfg);
    app.view.requestDraw();
    refreshSidebar();
  };
  const set = (k, v) => apply("edit passage", () => { p[k] = v; });
  return [h("div", { class: "sec" }, h("h3", {}, p.source === "config" ? "Passage" : "Link (drawn here)"),
    h("div", { class: "kv" },
      h("label", {}, "On"), h("label", {}, h("input", { type: "checkbox", checked: p.enabled !== false, onchange: (e) => { e.target.blur(); set("enabled", e.target.checked); } }), " connects and is drawn"),
      h("label", {}, "Name"), h("input", { type: "text", value: p.name, onchange: (e) => set("name", e.target.value) }),
      h("label", {}, "Kind"), h("select", { onchange: (e) => set("kind", e.target.value) }, ["canal", "strait", "route"].map((k) => h("option", { value: k, selected: p.kind === k }, k))),
      h("span", {}, "Tiles"), h("span", {}, info?.ta ? tileChip(info.ta) : "–", " ↔ ", info?.tb ? tileChip(info.tb) : "–"),
      h("span", {}, "Status"), h("span", { class: info?.status === "ok" ? "good" : "warn" }, info?.status || "–", info?.natural ? " (tiles already touch)" : "")),
    h("p", { class: "muted" }, "Drag an end or a point to move it. Drag the line to add a point. Alt+click a point removes it.")),
  h("div", { class: "sec" }, h("h3", {}, `Waypoints (${via.length})`),
    h("div", { class: "list" }, via.map((q, i) => h("div", { class: "li", style: "cursor:default" },
      h("span", { class: "grow" }, `${i + 1}: ` + d.proj.inverse(...q).map((v) => fmt(v, 2)).join(", ")),
      h("button", { title: "remove this point", onclick: () => apply("remove waypoint", () => p.via_mm.splice(i, 1)) }, "✕"))))),
  h("div", { class: "row" },
    via.length ? h("button", { onclick: () => apply("straighten passage", () => { p.via_mm = []; }) }, "Straighten") : null,
    main ? h("button", { onclick: () => apply("default route", () => {
      const { a_mm, b_mm, via_mm } = d.passageFromConfig(main);
      Object.assign(p, { a_mm, b_mm, via_mm });
    }) }, "Use default route") : null,
    h("button", { class: "danger", onclick: deleteSelection }, "Delete"))];
}

function arrowInspector(key) {
  const d = app.design, look = d.meta.look;
  d.ensureAnalysis(app.cfg);
  const w = findArrow(key);
  if (!w) return h("p", { class: "muted" }, "These tiles no longer share an edge across the map's sides.");
  const a = d.analysis;
  const change = (label, what) => {
    d.editArrow(label, key, what);
    d.ensureAnalysis(app.cfg);
    app.view.requestDraw();
    refreshSidebar();
  };
  const linked = a.graph.get(w.left)?.get(w.right);
  const spots = d.arrowSpotsFor(w);
  return [h("div", { class: "sec" }, h("h3", {}, "Crossing (around the world)"),
    h("div", { class: "kv" },
      h("span", {}, "Tiles"), h("span", {}, tileChip(w.left), " ↔ ", tileChip(w.right)),
      h("span", {}, "Arrow at"), h("span", {}, `${fmt(w.y_mm, 2)} mm (can be ${fmt(spots[0])} to ${fmt(spots[spots.length - 1])})`),
      h("span", {}, "Arrow"), h("span", {}, w.closed ? "none: crossing closed" : w.hidden ? "hidden" : look.wraps ? "shown" : "off: View › Wrap-around arrows"),
      h("span", {}, "Connects"), h("span", { class: w.closed ? "warn" : "good" },
        !w.closed ? "yes" : linked ? `crossing closed, still linked by ${linked}` : "no: closed")),
    h("p", { class: "muted" }, "Drag the arrow along the yellow edge, or use the up and down keys (Shift: 5 mm). Both sides move together."),
    a.unreachable.length ? h("p", { class: "warn" }, `${a.unreachable.length} tile(s) cannot be reached from the rest (see Report).`) : null),
  h("div", { class: "sec" }, h("h3", {}, "This crossing"),
    h("div", { class: "row" },
      w.closed ? null : h("button", { onclick: () => change(w.hidden ? "show arrow" : "hide arrow", { hidden: !w.hidden }) }, w.hidden ? "Show arrow" : "Hide arrow only"),
      h("button", { class: w.closed ? "" : "danger", onclick: () => change(w.closed ? "open crossing" : "close crossing", { closed: !w.closed }) }, w.closed ? "Open crossing" : "Close crossing"),
      h("button", { disabled: !w.edited, onclick: () => change("arrow back to automatic", { y_mm: undefined, hidden: false, closed: false }) }, "Back to automatic")),
    h("p", { class: "muted" }, "Hide: players don't see the arrow, the tiles still connect. Close: no arrow and no connection.")),
  h("div", { class: "sec" }, h("h3", {}, "All arrows"),
    h("div", { class: "formgrid" }, h("label", {}, "Size"), arrowSizeSlider(), h("label", {}, "Colour"), arrowColourControl()))];
}

function crossingsList(a) {
  const d = app.design;
  const state = (w) => (w.closed ? "closed" : w.hidden ? "arrow hidden" : w.edited ? "moved" : "automatic");
  return h("div", { class: "sec" }, h("h3", {}, `Crossings around the world (${a.wraps.length})`),
    h("div", { class: "list" }, [...a.wraps].sort((x, y) => x.y_mm - y.y_mm).map((w) =>
      h("div", { class: "li crossing", onclick: () => select("arrow", w.key) },
        h("span", { class: "grow" }, `${w.left} ↔ ${w.right}`),
        h("span", { class: w.closed ? "warn" : "muted" }, state(w))))),
    Object.keys(d.meta.arrows).length ? h("button", { style: "margin-top:6px", onclick: () => {
      d.edit("reset all arrows", (m) => { m.arrows = {}; });
      d.ensureAnalysis(app.cfg);
      refreshSidebar();
    } }, "All back to automatic") : null);
}

function renderSeas() {
  const d = app.design;
  if (!d) return null;
  const counts = new Map();
  for (const t of d.meta.tiles) counts.set(t.sea, (counts.get(t.sea) || 0) + 1);
  const selSea = app.sel.sea && d.sea(app.sel.sea);
  const out = [];
  if (selSea) {
    const s = selSea;
    const set = (k, v) => { d.edit("edit sea", () => { s[k] = v; }); app.view.rebuildOverlay(null); };
    out.push(h("div", { class: "sec" }, h("h3", {}, s.name),
      h("div", { class: "formgrid" },
        h("label", {}, "Name (en)"), h("input", { type: "text", value: s.name, onchange: (e) => {
          const nv = e.target.value.trim(); if (!nv || d.sea(nv)) return;
          d.edit("rename sea", (m) => { m.tiles.forEach((t) => { if (t.sea === s.name) t.sea = nv; }); s.name = nv; });
          app.sel.sea = nv; refreshSidebar(); } }),
        h("label", {}, "Name (nl)"), h("input", { type: "text", value: s.name_nl || "", onchange: (e) => set("name_nl", e.target.value) }),
        h("label", {}, "Class"), h("select", { onchange: (e) => set("class", e.target.value) }, ["ocean", "sea", "gulf", "bay"].map((c) => h("option", { value: c, selected: s.class === c }, c))),
        h("label", {}, "Colour"), h("input", { type: "color", value: s.color, onchange: (e) => set("color", e.target.value) }),
        h("label", {}, "Label"), h("label", {}, h("input", { type: "checkbox", checked: s.show_label !== false, onchange: (e) => set("show_label", e.target.checked) }), " show name on the board"),
        h("label", {}, "Label size"), h("input", { type: "number", step: 0.2, value: s.label_size_mm ?? "", placeholder: "config", onchange: (e) => set("label_size_mm", e.target.value === "" ? null : +e.target.value) })),
      h("div", { class: "row", style: "margin-top:8px" },
        h("button", { onclick: () => select("tiles", d.meta.tiles.filter((t) => t.sea === s.name).map((t) => t.id)) }, `Select its ${counts.get(s.name) || 0} tiles`),
        !s.label_mm ? h("button", { onclick: () => { const ts = d.meta.tiles.filter((t) => t.sea === s.name && t.pawn_mm); if (ts.length) set("label_mm", [ts[0].pawn_mm[0], ts[0].pawn_mm[1] + 9]); } }, "Place label") : null,
        h("span", { class: "muted" }, "Drag the name on the map to move it."))));
  }
  out.push(h("div", { class: "sec" }, h("h3", {}, `Seas (${d.meta.seas.length})`),
    h("div", { class: "list" }, [...d.meta.seas].sort((x, y) => (counts.get(y.name) || 0) - (counts.get(x.name) || 0)).map((s) =>
      h("div", { class: "li", onclick: () => select("sea", s.name), style: app.sel.sea === s.name ? "background:var(--panel-2)" : "" },
        h("span", { class: "swatch", style: `background:${s.color}` }),
        h("span", { class: "grow" }, s.name, h("span", { class: "muted" }, " · " + s.class)),
        h("span", { class: "num" }, counts.get(s.name) || 0)))),
    h("div", { class: "row", style: "margin-top:8px" }, h("button", { onclick: async () => {
      const name = await promptBox("New sea", "Name", "");
      if (!name || d.sea(name)) return;
      d.edit("add sea", (m) => m.seas.push({ name, name_nl: name, class: "sea", color: randomColour(), label_mm: null, label_size_mm: null, show_label: true }));
      select("sea", name);
    } }, "+ Add sea"), h("span", { class: "muted" }, "Assign tiles in the Inspect tab."))));
  return out;
}

// ---------------------------------------------------------------- fields tab + edge track generator
function renderFieldsTab() {
  const d = app.design;
  if (!d) return null;
  const g = app.edgeGen || (app.edgeGen = Object.assign({ edge: "top", count: 10, w: 18, h: 18, gap: "", inset: "", shape: "rounded",
    kind: "track", color: "#2f5d7c", label: "{n}", start: 1, rotate: false }, store("edgeGen") || {}));
  const save = () => store("edgeGen", g);
  const inp = (k, attrs = {}) => h("input", { type: attrs.type || "number", value: g[k], ...attrs, oninput: (e) => { g[k] = attrs.type === "text" ? e.target.value : e.target.value === "" ? "" : +e.target.value; save(); } });
  const fr = d.frame;
  const kinds = new Map();
  for (const f of d.meta.fields) { const k = f.kind || "field"; if (!kinds.has(k)) kinds.set(k, []); kinds.get(k).push(f); }
  return [
    h("div", { class: "sec" }, h("h3", {}, "Day track and legend"),
      ...boardParts().map((b) => h("div", { class: "row", style: "margin-bottom:4px" },
        h("label", {}, h("input", { type: "checkbox", checked: b.shown,
          onchange: (e) => { e.target.blur(); b.toggle(); } }), " " + b.name),
        h("button", { style: "margin-left:auto", onclick: b.reset }, `Reset ${b.name.toLowerCase()}`)))),
    h("div", { class: "sec" }, h("h3", {}, "Edge track generator"),
      h("p", { class: "muted" }, `Lays out a row of fields along a board edge. Board ${d.board.width_mm}×${d.board.height_mm} mm; frame ${fr.top}/${fr.right}/${fr.bottom}/${fr.left} mm (set under Frame in the menubar, then regenerate, to keep fields off the map).`),
      h("div", { class: "formgrid" },
        h("label", {}, "Edge"), h("select", { onchange: (e) => { g.edge = e.target.value; save(); } },
          [["top", "top"], ["bottom", "bottom"], ["left", "left"], ["right", "right"], ["around", "all around (perimeter)"], ["panel", "bottom panel"]].map(([v, l]) => h("option", { value: v, selected: g.edge === v }, l))),
        h("label", {}, "Count"), inp("count", { min: 1 }),
        h("label", {}, "w × h (mm)"), h("div", { class: "row" }, inp("w", { min: 1, step: 0.5, style: "width:70px" }), inp("h", { min: 1, step: 0.5, style: "width:70px" })),
        h("label", {}, "Gap (mm)"), inp("gap", { placeholder: "auto: spread out" }),
        h("label", {}, "Inset (mm)"), inp("inset", { step: 0.5, placeholder: "auto: centred in the frame" }),
        h("label", {}, "Shape"), h("select", { onchange: (e) => { g.shape = e.target.value; save(); } }, ["rect", "rounded", "circle", "hex", "diamond"].map((s) => h("option", { value: s, selected: g.shape === s }, s))),
        h("label", {}, "Kind"), h("input", { type: "text", value: g.kind, list: "kinds", oninput: (e) => { g.kind = e.target.value; save(); } }),
        h("label", {}, "Label"), h("input", { type: "text", value: g.label, title: "{n} = number", oninput: (e) => { g.label = e.target.value; save(); } }),
        h("label", {}, "First number"), inp("start"),
        h("label", {}, "Colour"), h("input", { type: "color", value: g.color, oninput: (e) => { g.color = e.target.value; save(); } }),
        h("label", {}, "Rotate"), h("label", {}, h("input", { type: "checkbox", checked: g.rotate, onchange: (e) => { g.rotate = e.target.checked; save(); } }), " face outward on each side")),
      h("div", { class: "row", style: "margin-top:8px" }, h("button", { class: "primary", onclick: () => generateTrack(g) }, "Add track"))),
    h("div", { class: "sec" }, h("h3", {}, `Fields (${d.meta.fields.length})`),
      d.meta.fields.length ? null : h("p", { class: "muted" }, "None yet. Use the Fields tool (F) or the generator above."),
      ...[...kinds].map(([k, fs]) => h("div", { style: "margin-bottom:8px" },
        h("div", { class: "row" }, h("b", {}, k), h("span", { class: "muted" }, `${fs.length}`),
          h("button", { style: "margin-left:auto", onclick: async () => {
            if (await confirmBox("Delete fields", `Delete all ${fs.length} fields of kind '${k}'?`, "Delete", true)) {
              d.edit("delete fields", (m) => { m.fields = m.fields.filter((f) => (f.kind || "field") !== k); }); select(null);
            } } }, "delete all")),
        h("div", { class: "chips", style: "margin-top:4px" }, fs.map((f) => h("span", { class: "chip", onclick: () => { select("field", f.id); app.view.centerOn(f.x, f.y); } }, fieldChip(f)))))),
    ),
  ];
}

function fieldChip(f) {
  const name = f.shape === "legend" ? "Legend" : fieldLabels(f, boardText(app)).label || "·";
  return f.hidden ? `${name} (hidden)` : name;
}

// ---------------------------------------------------------------- day track + legend
const inDayTrack = (f) => f.group === "day-track";
const isBoardLegend = (f) => f.id === "legend";

function boardParts() {
  return [["Day track", inDayTrack, resetDayTrack], ["Legend", isBoardLegend, resetLegend]].map(([name, match, reset]) => {
    const list = app.design?.meta.fields.filter(match) || [];
    const shown = list.some((f) => !f.hidden);
    return { name, shown, reset, toggle: () => {
      if (!list.length) { reset(); return; }        // all deleted: showing brings the default back
      app.design.edit(`${shown ? "hide" : "show"} ${name.toLowerCase()}`,
        (m) => m.fields.filter(match).forEach((f) => { f.hidden = shown; }));
      refreshSidebar();
    } };
  });
}

async function resetBoardPart(name, match, pick) {
  const d = app.design;
  try {
    const fresh = pick(await postJSON("/api/board-fields", { board: d.board, config: app.cfg }));
    if (d !== app.design) return;
    if (!fresh.length) { toast("No room for day squares: space_mm is 0, or the bottom panel is lower than 6 mm", true); return; }
    d.edit(`reset ${name}`, (m) => { m.fields = [...fresh, ...m.fields.filter((f) => !match(f))]; });
    refreshSidebar();
    toast(`The ${name} is back to its default (Ctrl+Z undoes it)`);
  } catch (e) { toast(e.message, true); }
}
function resetDayTrack() { return resetBoardPart("day track", inDayTrack, (r) => r.days); }
function resetLegend() { return resetBoardPart("legend", isBoardLegend, (r) => [r.legend]); }

function generateTrack(g) {
  const d = app.design, b = d.board, fr = d.frame;
  const n = Math.max(1, Math.round(g.count));
  const group = "track-" + Date.now().toString(36);
  const W = b.width_mm, H = b.height_mm;
  const fields = [];
  const mk = (x, y, rot, i) => fields.push({ id: group + "-" + i, kind: g.kind, label: g.label.replace("{n}", String(g.start + i)),
    shape: g.shape, x: round2(x), y: round2(y), w: g.w, h: g.h, rotation: rot, color: g.color, opacity: 1, notes: "", group });
  const spread = (from, to, along) => {
    const L = to - from;
    let gap = g.gap === "" || g.gap == null ? (n > 1 ? (L - n * along) / (n - 1) : 0) : +g.gap;
    if (gap < 0) gap = 0;
    const total = n * along + (n - 1) * gap;
    const start = from + (L - total) / 2 + along / 2;
    return Array.from({ length: n }, (_, i) => start + i * (along + gap));
  };
  const vertical = g.edge === "left" || g.edge === "right";
  const along = g.rotate || !vertical ? g.w : g.h, perp = g.rotate || !vertical ? g.h : g.w;
  // inset: distance from the board edge; auto = centred in the frame (2 mm without a frame)
  const auto = (f) => (f > perp ? (f - perp) / 2 : 2);
  const sideFrame = g.edge === "around" ? Math.min(fr.top, fr.right, fr.bottom, fr.left) : g.edge === "panel" ? 0 : fr[g.edge] || 0;
  g = { ...g, inset: g.inset === "" || g.inset == null ? auto(sideFrame) : +g.inset };
  if (g.edge === "top") spread(g.inset, W - g.inset, along).forEach((x, i) => mk(x, g.inset + perp / 2, g.rotate ? 180 : 0, i));
  else if (g.edge === "bottom") spread(g.inset, W - g.inset, along).forEach((x, i) => mk(x, H - g.inset - perp / 2, 0, i));
  else if (g.edge === "left") spread(g.inset, H - g.inset, along).forEach((y, i) => mk(g.inset + perp / 2, y, g.rotate ? 90 : 0, i));
  else if (g.edge === "right") spread(g.inset, H - g.inset, along).forEach((y, i) => mk(W - g.inset - perp / 2, y, g.rotate ? -90 : 0, i));
  else if (g.edge === "panel") {
    const y = fr.top + b.map_height_mm + b.panel_height_mm / 2;
    spread(fr.left + Math.max(g.inset, 4), fr.left + b.inner_width_mm - Math.max(g.inset, 4), g.w).forEach((x, i) => mk(x, y, 0, i));
  } else {   // around the board, clockwise from the top-left corner
    const o = g.inset + g.h / 2;
    const w = W - 2 * o, hh = H - 2 * o, P = 2 * (w + hh);
    const step = P / n;
    for (let i = 0; i < n; i++) {
      let s = i * step, x, y, rot;
      if (s < w) { x = o + s; y = o; rot = 180; }
      else if ((s -= w) < hh) { x = W - o; y = o + s; rot = -90; }
      else if ((s -= hh) < w) { x = W - o - s; y = H - o; rot = 0; }
      else { s -= w; x = o; y = H - o - s; rot = 90; }
      mk(x, y, g.rotate ? rot : 0, i);
    }
  }
  d.edit(`add ${n} fields`, (m) => m.fields.push(...fields));
  toast(`${n} fields added along ${g.edge}`);
  refreshSidebar();
}

// ---------------------------------------------------------------- report + log
function renderReport() {
  const d = app.design;
  if (!d) return null;
  const a = d.ensureAnalysis(app.cfg);
  const pawn = app.cfg.tiles.pawn_diameter_mm;
  const tiles = d.meta.tiles.filter((t) => a.area[t.id] > 0);
  const tight = tiles.filter((t) => a.inscribedPx[t.id] * 2 / d.ppm < pawn).sort((x, y) => a.inscribedPx[x.id] - a.inscribedPx[y.id]);
  const frag = tiles.filter((t) => a.pieces[t.id] > 1);
  const areas = tiles.map((t) => a.area[t.id]);
  const mean = areas.reduce((s, x) => s + x, 0) / (areas.length || 1);
  const small = tiles.filter((t) => a.area[t.id] < mean * 0.4);
  const big = tiles.filter((t) => a.area[t.id] > mean * 1.8);
  const orphanPx = (() => { let n = 0; for (let i = 0; i < d.lab.length; i++) if (d.lab[i] > 0 && !d.tile(d.lab[i])) n++; return n; })();
  const bySea = new Map();
  for (const t of tiles) bySea.set(t.sea, (bySea.get(t.sea) || 0) + 1);
  const issue = (title, list, fmtFn) => h("div", { class: "sec" }, h("h3", {}, `${title} (${list.length})`),
    list.length ? h("div", { class: "chips" }, list.map((t) => h("span", { class: "chip warn", onclick: () => focusTile(t.id), title: fmtFn ? fmtFn(t) : "" }, t.id, fmtFn ? h("span", { class: "muted", style: "padding-left:4px" }, "· " + fmtFn(t)) : null)))
      : h("div", { class: "good" }, "none"));
  return [summaryStats(),
    issue(`Pawn (${pawn} mm) does not fit`, tight, (t) => fmt(a.inscribedPx[t.id] * 2 / d.ppm) + " mm"),
    issue("Tiles in more than one piece", frag, (t) => a.pieces[t.id] + " pieces"),
    issue("Not reachable from the rest", (a.unreachable || []).map((id) => ({ id }))),
    issue("Much smaller than average (< 40 %)", small, (t) => fmt(a.area[t.id] / d.ppm / d.ppm, 0) + " mm²"),
    issue("Much bigger than average (> 180 %)", big, (t) => fmt(a.area[t.id] / d.ppm / d.ppm, 0) + " mm²"),
    crossingsList(a),
    h("div", { class: "sec" }, h("h3", {}, "Passages"),
      h("div", { class: "list" }, (a.passageInfo || []).map((pi) => h("div", { class: "li", onclick: () => select("passage", pi.p) },
        h("span", { class: "grow" }, pi.p.name, h("span", { class: "muted" }, ` · ${pi.p.kind}${pi.p.source !== "config" ? " · drawn" : ""}`)),
        h("span", { class: pi.status === "ok" ? "good" : pi.status === "off" ? "muted" : "warn" }, pi.status === "ok" ? `${pi.ta} ↔ ${pi.tb}` : pi.status))))),
    h("div", { class: "sec" }, h("h3", {}, "Tiles per sea"),
      h("div", { class: "list" }, [...bySea].sort((x, y) => y[1] - x[1]).map(([s, n]) => h("div", { class: "li", onclick: () => select("tiles", tiles.filter((t) => t.sea === s).map((t) => t.id)) },
        h("span", { class: "swatch", style: `background:${d.sea(s)?.color || "#888"}` }), h("span", { class: "grow" }, s), h("span", { class: "num" }, n))))),
    orphanPx ? h("p", { class: "warn" }, `${orphanPx} pixels belong to tile ids without data.`) : null,
  ];
}

function renderLog() {
  const j = app.job;
  if (!j) return h("p", { class: "muted" }, "No job has run yet. Generate, map image and export jobs show their output here.");
  const pre = h("pre", { class: "log" }, app.jobLog.join("\n"));
  setTimeout(() => { const b = $("#tabbody"); b.scrollTop = b.scrollHeight; }, 0);
  return [h("div", { class: "sec" }, h("h3", {}, j.title),
    h("div", { class: "row" }, h("span", { class: j.status === "error" ? "warn" : j.status === "done" ? "good" : "" }, j.status),
      j.status === "running" ? h("button", { onclick: () => postJSON("/api/jobs/cancel") }, "Cancel") : null,
      j.error ? h("span", { class: "warn" }, j.error) : null)), pre];
}

// ================================================================ help
function helpDialog() {
  const rows = [["V M A G B E F L H", "tools: select, move, add/split, merge, brush, eraser, fields, link, pan"],
    ["Space + drag", "pan (also middle or right mouse)"], ["Wheel", "zoom at the pointer"], ["0  +  −", "fit, zoom in, zoom out"],
    ["Shift + click", "add a tile to the selection"], ["Ctrl+G / Enter", "merge the selected tiles"], ["Del", "delete the selection"],
    ["Ctrl+Z / Ctrl+Y", "undo / redo"], ["Ctrl+S", "save"], ["Ctrl+E", "export"], ["[  ]", "brush size"], ["Alt + click", "brush: pick the tile to paint · on a passage point: remove it"],
    ["Drag a passage", "click it first, then drag the line to bend it"],
    ["Drag an edge arrow", "move it along the edge its tiles share; up/down keys too, Del hides it"],
    ["Arrows", "nudge the selected field (Shift: 5 mm)"], ["Ctrl+D", "duplicate the selected field"], ["Esc", "clear selection, cancel a link"]];
  dialog("Keyboard and mouse", h("div", { class: "keys" }, rows.flatMap(([k, v]) => [h("span", {}, h("kbd", {}, k)), h("span", {}, v)])));
}
function aboutDialog() {
  dialog("About", [h("p", {}, "Sea Board Designer: iterate on the board of the co-op sea game."),
    h("p", {}, "Settings follow the defaults (", h("code", {}, app.paths?.defaults || "../src/config.yaml"), "), except what you change here (",
      h("code", {}, app.paths?.settings || "state/config.yaml"), "). Reset to defaults drops your changes."),
    h("p", { class: "muted" }, "Tiles are edited as a raster (4 px per mm like the generator). Move and split regrow tiles with the same geodesic Voronoi and area balancing as make_tiles.py.")]);
}

boot();
