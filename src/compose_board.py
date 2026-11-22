"""Put the board together: art + tile borders + names + passages + day track.

Output (in <output_dir>/board/): board.svg, board.pdf, board.png (print dpi), board_preview.jpg
"""
import base64
import io
import re
from pathlib import Path

import numpy as np
from PIL import Image

from board_common import load_config, load_json, parse_args

Image.MAX_IMAGE_PIXELS = None
DAYS = {
    "en": (["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
           ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
           {"canal": "Canal", "strait": "Strait", "wrap": "Sail around the world"}),
    "nl": (["MA", "DI", "WO", "DO", "VR", "ZA", "ZO"],
           ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"],
           {"canal": "Kanaal", "strait": "Zeestraat", "wrap": "Rond de wereld varen"}),
}


def extra_args(p):
    p.add_argument("--art", choices=["config", "art", "guide", "none"], default="config",
                   help="map image: SDXL art, the atlas guide map, or none (default: compose.map_art)")
    p.add_argument("--no-png", action="store_true", help="skip the full-size PNG (faster)")


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def halo_text(x, y, content, attrs, halo_color, halo_w, halo_opacity=1.0):
    """Text with an outline under it: two elements (cairosvg does not support SVG paint order)."""
    bare = re.sub(r'\sfill="[^"]*"', "", " " + attrs)
    under = (f'<text x="{x:.2f}" y="{y:.2f}"{bare} fill="none" stroke="{halo_color}" '
             f'stroke-opacity="{halo_opacity}" stroke-width="{halo_w:.2f}" stroke-linejoin="round">{content}</text>')
    return [under, f'<text x="{x:.2f}" y="{y:.2f}" {attrs}>{content}</text>']


def path_d(pts, closed):
    d = "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in pts)
    return d + (" Z" if closed else "")


def main():
    args = parse_args(__doc__, extra_args)
    cfg = load_config(args)
    c, dt = cfg["compose"], cfg["day_track"]
    out_root = Path(cfg["output_dir"])
    tj = load_json(out_root / "tiles/tiles.json")
    borders = load_json(out_root / "tiles/borders.json")
    b = tj["board"]
    W, H, MH, PH = b["width_mm"], b["height_mm"], b["map_height_mm"], b["panel_height_mm"]
    abbr, full, words = DAYS[c["language"]]
    font = c["font"]
    ink = c["border_color"]
    out = out_root / "board"
    out.mkdir(parents=True, exist_ok=True)

    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
           f'width="{W}mm" height="{H}mm" viewBox="0 0 {W} {H}">',
           f'<rect width="{W}" height="{H}" fill="{dt["panel_color"]}"/>']

    # --- map image
    choice = args.art
    if choice == "config":
        choice = c.get("map_art", "guide")
    if choice != "none":
        im = Image.open(out_root / f"art/{choice}.png").convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=93)
        data = base64.b64encode(buf.getvalue()).decode()
        svg.append(f'<image x="0" y="0" width="{W}" height="{MH:.3f}" preserveAspectRatio="none" '
                   f'xlink:href="data:image/jpeg;base64,{data}"/>')
    else:
        svg.append(f'<rect width="{W}" height="{MH:.3f}" fill="#3d6f93"/>')

    # --- borders: dark under-stroke for contrast, light line on top
    for under in (True, False):
        for bd in borders:
            wmm = c["region_border_mm"] if bd["kind"] == "region" else c["tile_border_mm"]
            col, op = ("#0b1d2b", 0.35) if under else (ink, 0.9)
            ww = wmm * 2.2 if under else wmm
            svg.append(f'<path d="{path_d(bd["pts"], bd["closed"])}" fill="none" stroke="{col}" '
                       f'stroke-opacity="{op}" stroke-width="{ww:.2f}" stroke-linejoin="round" '
                       f'stroke-linecap="round"/>')

    # --- passages (drawn along their route through the water)
    for p in tj["passages"]:
        if not p["drawn"]:
            continue
        pts = p.get("path_mm") or [p["a_mm"], p["b_mm"]]
        d = path_d(pts, False)
        dash = "2.2,1.4" if p["kind"] == "canal" else "0.6,1.2"
        svg.append(f'<path d="{d}" fill="none" stroke="#0b1d2b" stroke-width="1.8" stroke-opacity="0.5" '
                   f'stroke-linecap="round" stroke-linejoin="round"/>')
        svg.append(f'<path d="{d}" fill="none" stroke="{ink}" stroke-width="0.9" stroke-dasharray="{dash}" '
                   f'stroke-linecap="round" stroke-linejoin="round"/>')
        for x, y in (pts[0], pts[-1]):
            svg.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="0.9" fill="{ink}" stroke="#0b1d2b" stroke-width="0.3"/>')

    # --- wrap-around arrows on the left and right edges, labelled with the tile on the other side
    for wv in tj["wraps"]:
        y = wv["y_mm"]
        for x, s_, target in ((0.0, -1, wv["right"]), (W, 1, wv["left"])):
            base = x - s_ * 3.2
            svg.append(f'<path d="M{base:.2f},{y - 2.2:.2f} L{x:.2f},{y:.2f} L{base:.2f},{y + 2.2:.2f} Z" '
                       f'fill="{ink}" fill-opacity="0.9" stroke="#0b1d2b" stroke-width="0.3"/>')
            tx = base - s_ * 0.8
            anchor = "start" if s_ < 0 else "end"
            svg += halo_text(tx, y + 1.25, target, f'font-family="{font}" font-size="3.6" font-weight="bold" '
                             f'text-anchor="{anchor}" fill="{ink}"', "#0b1d2b", 0.8)

    # --- tile numbers at the pawn spots
    pawn_r = b["pawn_diameter_mm"] / 2
    if c["show_tile_numbers"]:
        for t in tj["tiles"]:
            x, y = t["pawn_mm"]
            svg += halo_text(x, y + 1.4, t["id"], f'font-family="{font}" font-size="4" font-weight="bold" '
                             f'text-anchor="middle" fill="{ink}"', "#0b1d2b", 0.9)

    # --- sea names (positions chosen in make_tiles.py)
    if c["show_sea_names"]:
        for s_ in tj["seas"]:
            name = s_["name_nl"] if c["language"] == "nl" else s_["name"]
            big = s_["class"] == "ocean"
            x, y = s_["label_mm"]
            size = s_["label_size_mm"]
            svg += halo_text(x, y + size * 0.36, esc(name.upper() if big else name),
                             f'font-family="{font}" font-style="italic" font-size="{size}" '
                             f'letter-spacing="{s_["label_spacing_mm"]}" text-anchor="middle" fill="{ink}"',
                             "#0b1d2b", size * 0.18, 0.55)

    # --- bottom panel: day track
    if PH > 5:
        S, G, WG = dt["space_mm"], dt["gap_mm"], dt["weekend_gap_mm"]
        S = min(S, PH - 6)
        total = 7 * S + 5 * G + WG
        x = (W - total) / 2
        y = MH + (PH - S) / 2
        svg.append(f'<line x1="0" y1="{MH:.2f}" x2="{W}" y2="{MH:.2f}" stroke="{ink}" stroke-width="0.6"/>')
        for i in range(7):
            weekend = i >= 5
            col = dt["weekend_color"] if weekend else dt["workday_color"]
            svg.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{S}" height="{S}" rx="{S * 0.18:.2f}" '
                       f'fill="{col}" stroke="{ink}" stroke-width="0.6"/>')
            svg.append(f'<text x="{x + S / 2:.2f}" y="{y + S * 0.52:.2f}" font-family="{font}" '
                       f'font-size="{S * 0.3:.1f}" font-weight="bold" text-anchor="middle" '
                       f'fill="{dt["text_color"]}">{abbr[i]}</text>')
            svg.append(f'<text x="{x + S / 2:.2f}" y="{y + S * 0.8:.2f}" font-family="{font}" '
                       f'font-size="{S * 0.13:.1f}" font-style="italic" text-anchor="middle" '
                       f'fill="{dt["text_color"]}" fill-opacity="0.85">{full[i]}</text>')
            x += S + (WG if i == 4 else G)
        # legend at the right of the panel
        lx, ly = W - 70, MH + PH / 2 - 6
        items = [("canal", "2.2,1.4"), ("strait", "0.6,1.2")]
        for k, (key, dash) in enumerate(items):
            yy = ly + k * 6
            svg.append(f'<line x1="{lx}" y1="{yy}" x2="{lx + 10}" y2="{yy}" stroke="{ink}" stroke-width="0.9" '
                       f'stroke-dasharray="{dash}"/>')
            svg.append(f'<text x="{lx + 13}" y="{yy + 1.3}" font-family="{font}" font-size="3.6" '
                       f'fill="{ink}">{words[key]}</text>')
        yy = ly + 12
        svg.append(f'<path d="M{lx},{yy - 2} L{lx + 3.2},{yy} L{lx},{yy + 2} Z" fill="{ink}"/>')
        svg.append(f'<text x="{lx + 13}" y="{yy + 1.3}" font-family="{font}" font-size="3.6" '
                   f'fill="{ink}">{words["wrap"]}</text>')
    svg.append("</svg>")

    svg_text = "\n".join(svg)
    (out / "board.svg").write_text(svg_text)
    import cairosvg
    cairosvg.svg2pdf(bytestring=svg_text.encode(), write_to=str(out / "board.pdf"))
    prev = cairosvg.svg2png(bytestring=svg_text.encode(), output_width=2400)
    Image.open(io.BytesIO(prev)).convert("RGB").save(out / "board_preview.jpg", quality=88)
    if not args.no_png:
        px = int(round(W / 25.4 * c["print_dpi"]))
        cairosvg.svg2png(bytestring=svg_text.encode(), write_to=str(out / "board.png"), output_width=px)
    print(f"board ({choice}) -> {out}")


if __name__ == "__main__":
    main()
