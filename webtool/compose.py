"""The board as SVG: the only composer. The export (server.py) writes it to board.svg, board.pdf and the previews.

Layers, bottom to top: frame colour; on the map area the panel colour, the map image, tile colours and pawn circles,
tile borders, passages, edge arrows, tile numbers, sea names; then the line above the bottom panel and the fields
(day track, legend and the user's own). The editor draws the same layers itself (static/js/render.js).
"""
import base64
import io
import re

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
HALO = "#0b1d2b"        # dark outline under light lines and text
PLAIN_SEA = "#3d6f93"   # the map area when the map image is off


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def halo_text(x, y, content, attrs, halo_color, halo_w, halo_opacity=1.0):
    """Text with an outline under it: two elements (cairosvg does not support SVG paint order)."""
    bare = re.sub(r'\sfill="[^"]*"', "", " " + attrs)
    under = (f'<text x="{x:.2f}" y="{y:.2f}"{bare} fill="none" stroke="{halo_color}" '
             f'stroke-opacity="{halo_opacity}" stroke-width="{halo_w:.2f}" stroke-linejoin="round">{content}</text>')
    return [under, f'<text x="{x:.2f}" y="{y:.2f}" {attrs}>{content}</text>']


def path_d(pts, closed):
    d = "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in pts)
    return d + (" Z" if closed else "")


# ------------------------------------------------------------------ map layers
def map_image(path, W, MH):
    """The map image, embedded as JPEG; a plain sea when there is none."""
    if path is None:
        return f'<rect width="{W}" height="{MH:.3f}" fill="{PLAIN_SEA}"/>'
    buf = io.BytesIO()
    Image.open(path).convert("RGB").save(buf, "JPEG", quality=93)
    data = base64.b64encode(buf.getvalue()).decode()
    return (f'<image x="0" y="0" width="{W}" height="{MH:.3f}" preserveAspectRatio="none" '
            f'xlink:href="data:image/jpeg;base64,{data}"/>')


def borders_svg(borders, c):
    """Dark under-stroke for contrast, light line on top."""
    out = []
    for under in (True, False):
        for bd in borders:
            wmm = c["region_border_mm"] if bd["kind"] == "region" else c["tile_border_mm"]
            col, op = (HALO, 0.35) if under else (c["border_color"], 0.9)
            ww = wmm * 2.2 if under else wmm
            out.append(f'<path d="{path_d(bd["pts"], bd["closed"])}" fill="none" stroke="{col}" '
                       f'stroke-opacity="{op}" stroke-width="{ww:.2f}" stroke-linejoin="round" '
                       f'stroke-linecap="round"/>')
    return out


def passages_svg(passages, ink):
    """Passages, drawn along their route through the water."""
    out = []
    for p in passages:
        if not p["drawn"]:
            continue
        pts = p.get("path_mm") or [p["a_mm"], p["b_mm"]]
        d = path_d(pts, False)
        dash = "2.2,1.4" if p["kind"] == "canal" else "0.6,1.2"
        out.append(f'<path d="{d}" fill="none" stroke="{HALO}" stroke-width="1.8" stroke-opacity="0.5" '
                   f'stroke-linecap="round" stroke-linejoin="round"/>')
        out.append(f'<path d="{d}" fill="none" stroke="{ink}" stroke-width="0.9" stroke-dasharray="{dash}" '
                   f'stroke-linecap="round" stroke-linejoin="round"/>')
        for x, y in (pts[0], pts[-1]):
            out.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="0.9" fill="{ink}" stroke="{HALO}" stroke-width="0.3"/>')
    return out


def arrows_svg(wraps, W, font, colour, size=1.0):
    """Arrows on the left and right edges (around the world), labelled with the tile on the other side."""
    out = []
    n = lambda v: f"{round(v * size, 3):g}"      # noqa: E731
    for wv in wraps:
        y = wv["y_mm"]
        for x, s_, target in ((0.0, -1, wv["right"]), (W, 1, wv["left"])):
            base = x - s_ * 3.2 * size
            out.append(f'<path d="M{base:.2f},{y - 2.2 * size:.2f} L{x:.2f},{y:.2f} L{base:.2f},{y + 2.2 * size:.2f} Z" '
                       f'fill="{esc(colour)}" fill-opacity="0.9" stroke="{HALO}" stroke-width="{n(0.3)}"/>')
            at = f'<text x="{base - s_ * 0.8 * size:.2f}" y="{y + 1.25 * size:.2f}"'
            look = (f'font-family="{esc(font)}" font-size="{n(3.6)}" font-weight="bold" '
                    f'text-anchor="{"start" if s_ < 0 else "end"}"')
            out.append(f'{at} {look} fill="none" stroke="{HALO}" stroke-opacity="1.0" '
                       f'stroke-width="{0.8 * size:.2f}" stroke-linejoin="round">{target}</text>')
            out.append(f'{at} {look} fill="{esc(colour)}">{target}</text>')
    return out


def numbers_svg(tiles, font, ink):
    """Tile numbers at the pawn spots."""
    out = []
    for t in tiles:
        if t.get("pawn_mm"):
            x, y = t["pawn_mm"]
            out += halo_text(x, y + 1.4, t["id"], f'font-family="{esc(font)}" font-size="4" font-weight="bold" '
                             f'text-anchor="middle" fill="{esc(ink)}"', HALO, 0.9)
    return out


def names_svg(seas, language, font, ink):
    """Sea names at the spots chosen by the tile generator (or moved in the editor)."""
    out = []
    for s_ in seas:
        name = s_["name_nl"] if language == "nl" else s_["name"]
        x, y = s_["label_mm"]
        size = s_["label_size_mm"]
        out += halo_text(x, y + size * 0.36, esc(name.upper() if s_["class"] == "ocean" else name),
                         f'font-family="{esc(font)}" font-style="italic" font-size="{size}" '
                         f'letter-spacing="{s_["label_spacing_mm"]}" text-anchor="middle" fill="{esc(ink)}"',
                         HALO, size * 0.18, 0.55)
    return out


# ------------------------------------------------------------------ tile colours
def tile_rgb(tile, seas, fill):
    """The colour the editor gives a tile (colourTables in static/js/render.js)."""
    tid = int(tile["id"])
    if fill == "tile":
        hue, sat, light = (tid * 0.618034) % 1, 0.55, 0.55
        a = sat * min(light, 1 - light)

        def part(n):
            k = (n + hue * 12) % 12
            return int((light - a * max(-1, min(k - 3, 9 - k, 1))) * 255 + 0.5)
        return [part(0), part(8), part(4)]
    m = re.match(r"^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})",
                 (seas.get(tile["sea"]) or {}).get("color") or "#888888")
    shade = 0.86 + 0.14 * ((tid * 7) % 5) / 4
    return [int(np.rint(int(v, 16) * shade)) for v in m.groups()] if m else [200, 200, 200]


def fill_image(lab, design, look, scale):
    """Tile colours as a transparent PNG over the map, smoothed like the editor's canvas."""
    table = np.zeros((int(max([t["id"] for t in design["tiles"]] + [lab.max(), 0])) + 1, 4), np.uint8)
    seas = {s["name"]: s for s in design["seas"]}
    alpha = int(255 * float(look["fill_opacity"]) + 0.5)
    for t in design["tiles"]:
        table[int(t["id"])] = tile_rgb(t, seas, look["fill"]) + [alpha]
    im = Image.fromarray(table[lab], "RGBA")
    if scale > 1:
        im = im.resize((im.width * scale, im.height * scale), Image.BILINEAR)
    buf = io.BytesIO()
    im.save(buf, "PNG", compress_level=4)
    return base64.b64encode(buf.getvalue()).decode()


# ------------------------------------------------------------------ fields
def resolve_field(f, text):
    """A field with the day names filled in where they were not renamed."""
    f, i = dict(f), f.get("day")
    if i is not None:
        for key, words in (("label", "days"), ("sublabel", "day_names")):
            if f.get(key) is None:
                f[key] = text[words][i]
    return f


def legend_svg(f, font, ink, text, arrow_colour=None):
    colour = esc(f.get("text_color") or ink)
    k = min(float(f["w"]) / 62, float(f["h"]) / 18)
    op = float(f["opacity"] if f.get("opacity") is not None else 1)
    g = [f'<g transform="translate({f["x"]:.2f},{f["y"]:.2f}) rotate({float(f.get("rotation") or 0):.1f}) '
         f'scale({k:.4f})" opacity="{op}">']
    for i, dash in enumerate(("2.2,1.4", "0.6,1.2", None)):
        y = -6 + 6 * i
        if dash:
            g.append(f'<line x1="-30" y1="{y}" x2="-20" y2="{y}" stroke="{colour}" stroke-width="0.9" '
                     f'stroke-dasharray="{dash}"/>')
        else:
            g.append(f'<path d="M-30,{y - 2} L-26.8,{y} L-30,{y + 2} Z" '
                     f'fill="{esc(arrow_colour) if arrow_colour else colour}"/>')
        g.append(f'<text x="-17" y="{y + 1.3}" font-family="{esc(font)}" font-size="3.6" fill="{colour}">'
                 f'{esc(text["legend"][i])}</text>')
    g.append("</g>")
    return "\n".join(g)


def field_svg(f, font, ink):
    x, y = float(f.get("x", 0)), float(f.get("y", 0))
    w, h = float(f.get("w", 20)), float(f.get("h", 20))
    rot = float(f.get("rotation", 0) or 0)
    fill = f.get("color") or "#c8743a"
    stroke = f.get("stroke") or ink
    op = float(f.get("opacity", 1) if f.get("opacity") is not None else 1)
    shape = f.get("shape", "rect")
    style = f'fill="{esc(fill)}" fill-opacity="{op}" stroke="{esc(stroke)}" stroke-width="0.6"'
    g = [f'<g transform="translate({x:.2f},{y:.2f}) rotate({rot:.1f})">']
    if shape == "circle":
        g.append(f'<ellipse cx="0" cy="0" rx="{w / 2:.2f}" ry="{h / 2:.2f}" {style}/>')
    elif shape in ("hex", "diamond"):
        if shape == "hex":
            pts = [(w / 2 * np.cos(np.radians(60 * i + 30)), h / 2 * np.sin(np.radians(60 * i + 30))) for i in range(6)]
        else:
            pts = [(0, -h / 2), (w / 2, 0), (0, h / 2), (-w / 2, 0)]
        g.append('<polygon points="' + " ".join(f"{px:.2f},{py:.2f}" for px, py in pts) + f'" {style}/>')
    else:
        rx = min(w, h) * (0.18 if shape == "rounded" else 0.04)
        g.append(f'<rect x="{-w / 2:.2f}" y="{-h / 2:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{rx:.2f}" {style}/>')
    label = str(f.get("label") or "")
    sub = str(f.get("sublabel") or "")
    tc = f.get("text_color") or ink
    if label:
        lines = label.split("\n")
        if sub:     # big label with a small line under it
            fs = float(f.get("font_mm") or round(min(w, h) * 0.3, 1))
            base = h * 0.02 - (len(lines) - 1) * fs * 1.2
        else:
            fs = float(f.get("font_mm") or max(min(w, h) * 0.28, 1.5))
            base = fs * 0.35 - (len(lines) - 1) * fs * 0.6
        for i, ln in enumerate(lines):
            g.append(f'<text x="0" y="{base + i * fs * 1.2:.2f}" font-family="{esc(font)}" '
                     f'font-size="{fs:.2f}" font-weight="bold" text-anchor="middle" fill="{esc(tc)}">{esc(ln)}</text>')
    if sub:
        g.append(f'<text x="0" y="{h * (0.3 if label else 0.05):.2f}" font-family="{esc(font)}" '
                 f'font-size="{min(w, h) * 0.13:.1f}" font-style="italic" text-anchor="middle" '
                 f'fill="{esc(tc)}" fill-opacity="0.85">{esc(sub)}</text>')
    g.append("</g>")
    return "\n".join(g)


# ------------------------------------------------------------------ the whole board
def board_svg(design, tj, borders, lab, cfg, look, fields, text, art):
    """The board as SVG text.

    tj: the export's tiles.json (tiles, seas, wraps, passages); borders: the border lines; lab: tile per pixel;
    look: what is drawn (View menu); fields: the shown fields, day names filled in; art: the map image or None."""
    b, c = design["board"], cfg["compose"]
    ink, font = c["border_color"], c["font"]
    fr = b["frame"]
    TW, TH = float(b["width_mm"]), float(b["height_mm"])
    W, H, MH = tj["board"]["width_mm"], tj["board"]["height_mm"], tj["board"]["map_height_mm"]
    iw, ih = float(b["inner_width_mm"]), float(b["inner_height_mm"])
    ppm = design["raster"]["ppm"]

    inner = [f'<rect width="{W}" height="{H}" fill="{cfg["day_track"]["panel_color"]}"/>',
             map_image(art if c.get("map_art", True) else None, W, MH)]
    if look["fill"] != "none" and float(look["fill_opacity"]) > 0:
        scale = min(3, max(1, int(np.ceil(c["print_dpi"] / (ppm * 25.4)))))
        inner.append(f'<image x="0" y="0" width="{iw}" height="{b["map_height_mm"]:.3f}" '
                     f'preserveAspectRatio="none" '
                     f'xlink:href="data:image/png;base64,{fill_image(lab, design, look, scale)}"/>')
    if look["circles"]:
        radius = float(cfg["tiles"]["pawn_diameter_mm"]) / 2
        for t in tj["tiles"]:
            if t["pawn_mm"]:
                inner.append(f'<circle cx="{t["pawn_mm"][0]}" cy="{t["pawn_mm"][1]}" r="{radius}" fill="none" '
                             f'stroke="{esc(ink)}" stroke-opacity="0.6" stroke-width="0.35" '
                             f'stroke-dasharray="1,0.8"/>')
    if look["borders"]:
        inner += borders_svg(borders, c)
    if look["passages"]:
        inner += passages_svg(tj["passages"], ink)
    if look["wraps"]:
        arrows = [wv for wv in tj["wraps"] if not wv.get("hidden")]
        inner += arrows_svg(arrows, W, font, look["arrow_color"] or ink, float(look["arrow_size"]))
    if c["show_tile_numbers"]:
        inner += numbers_svg(tj["tiles"], font, ink)
    if c["show_sea_names"]:
        inner += names_svg(tj["seas"], c["language"], font, ink)

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
             f'width="{TW}mm" height="{TH}mm" viewBox="0 0 {TW} {TH}">',
             f'<rect width="{TW}" height="{TH}" fill="{esc(cfg["webtool"]["frame_color"])}"/>',
             f'<svg x="{fr["left"]}" y="{fr["top"]}" width="{iw}" height="{ih}" viewBox="0 0 {iw} {ih}" '
             f'overflow="hidden">', *inner, "</svg>"]
    if b["panel_height_mm"] > 5:
        y = fr["top"] + b["map_height_mm"]
        parts.append(f'<line x1="{fr["left"]}" y1="{y:.2f}" x2="{fr["left"] + iw}" y2="{y:.2f}" '
                     f'stroke="{esc(ink)}" stroke-width="0.6"/>')
    for f in fields:
        parts.append(legend_svg(f, font, ink, text, look["arrow_color"]) if f.get("shape") == "legend"
                     else field_svg(f, font, ink))
    parts.append("</svg>")
    return "\n".join(parts)
