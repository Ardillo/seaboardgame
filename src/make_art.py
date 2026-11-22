"""Paint the map art with SDXL, guided by a real-colour world map.

Steps:
  guide    reproject Natural Earth II (realistic colours + relief) to the board -> art/guide.png
  samples  a few 1024 px test crops at different strengths -> art/samples/  (pick a style first)
  full     the whole map, painted in overlapping 1024 px tiles -> art/art.png

The guide keeps continents in the right place; SDXL img2img only repaints the look.
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from board_common import Projection, load_config, parse_args

Image.MAX_IMAGE_PIXELS = None
SAMPLE_SPOTS = {           # name: (lon, lat) of the crop centre
    "europe_mediterranean": (15, 45),
    "caribbean": (-75, 18),
    "indonesia": (120, -2),
}


def extra_args(p):
    p.add_argument("step", choices=["guide", "samples", "full"])
    p.add_argument("--strengths", default="0.3,0.4,0.5", help="samples: strengths to try")


def make_guide(cfg, proj, out):
    src = Path(cfg["data_dir"]) / "NE2_50M_SR_W/NE2_50M_SR_W/NE2_50M_SR_W.tif"
    img = np.asarray(Image.open(src).convert("RGB"), np.float32)
    sh, sw = img.shape[:2]
    ppm = cfg["art"]["dpi"] / 25.4
    W, H = int(round(proj.width * ppm)), int(round(proj.map_h * ppm))
    ys, xs = np.mgrid[0:H, 0:W]
    lon, lat = proj.inverse((xs + 0.5) / ppm, (ys + 0.5) / ppm)
    sx = (lon + 180.0) / 360.0 * sw - 0.5
    sy = (90.0 - lat) / 180.0 * sh - 0.5
    outimg = np.stack([ndimage.map_coordinates(img[..., c], [sy, sx], order=1, mode="grid-wrap")
                       for c in range(3)], -1)
    guide = Image.fromarray(np.clip(outimg, 0, 255).astype(np.uint8))
    guide.save(out / "guide.png")
    print(f"guide {W}x{H} px -> {out / 'guide.png'}")
    return guide


def load_pipe(cfg):
    import torch
    from diffusers import StableDiffusionXLImg2ImgPipeline
    pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
        cfg["art"]["model"], torch_dtype=torch.float16, variant="fp16", use_safetensors=True)
    pipe.enable_model_cpu_offload()      # fits SDXL in ~6 GB of GPU memory
    pipe.vae.enable_tiling()
    pipe.set_progress_bar_config(disable=True)
    return pipe


def paint(pipe, cfg, crop, seed, strength=None):
    import torch
    a = cfg["art"]
    g = torch.Generator("cpu").manual_seed(seed)
    return pipe(prompt=a["prompt"], negative_prompt=a["negative_prompt"], image=crop,
                strength=strength if strength is not None else a["strength"],
                num_inference_steps=a["steps"], guidance_scale=a["guidance"],
                generator=g).images[0]


def windows(size, tile, overlap):
    if size <= tile:
        return [0]
    step = tile - overlap
    pos = list(range(0, size - tile, step)) + [size - tile]
    return sorted(set(pos))


def main():
    args = parse_args(__doc__, extra_args)
    cfg = load_config(args)
    proj = Projection(cfg)
    out = Path(cfg["output_dir"]) / "art"
    out.mkdir(parents=True, exist_ok=True)
    gpath = out / "guide.png"
    guide = make_guide(cfg, proj, out) if args.step == "guide" or not gpath.exists() else Image.open(gpath)
    if args.step == "guide":
        return
    a = cfg["art"]
    T = a["tile_px"]
    pipe = load_pipe(cfg)

    if args.step == "samples":
        sdir = out / "samples"
        sdir.mkdir(exist_ok=True)
        ppm = a["dpi"] / 25.4
        for name, (lon, lat) in SAMPLE_SPOTS.items():
            x, y = proj.forward(lon, lat)
            x0 = int(min(max(x * ppm - T / 2, 0), guide.width - T))
            y0 = int(min(max(y * ppm - T / 2, 0), guide.height - T))
            crop = guide.crop((x0, y0, x0 + T, y0 + T))
            row = [crop]
            for s in [float(v) for v in args.strengths.split(",")]:
                img = paint(pipe, cfg, crop, a["seed"], s)
                img.save(sdir / f"{name}_s{s:.2f}.png")
                row.append(img)
                print(f"sample {name} strength {s}")
            sheet = Image.new("RGB", (T * len(row), T))
            for i, im in enumerate(row):
                sheet.paste(im, (i * T, 0))
            sheet.resize((sheet.width // 2, sheet.height // 2)).save(sdir / f"{name}_sheet.jpg", quality=90)
        print(f"samples in {sdir} (each sheet: guide, then the strengths left to right)")
        return

    # full map: overlapping tiles, feathered together
    gw, gh = guide.size
    acc = np.zeros((gh, gw, 3), np.float64)
    wsum = np.zeros((gh, gw, 1), np.float64)
    ov = a["overlap_px"]
    ramp = np.minimum(1.0, (np.arange(T) + 1) / max(ov, 1))
    feather = np.minimum(ramp, ramp[::-1])
    mask = np.minimum.outer(feather, feather)[..., None]
    xs, ys = windows(gw, T, ov), windows(gh, T, ov)
    n = 0
    for y0 in ys:
        for x0 in xs:
            n += 1
            crop = guide.crop((x0, y0, x0 + T, y0 + T))
            img = np.asarray(paint(pipe, cfg, crop, a["seed"] + n), np.float64)
            acc[y0:y0 + T, x0:x0 + T] += img * mask
            wsum[y0:y0 + T, x0:x0 + T] += mask
            print(f"tile {n}/{len(xs) * len(ys)}", flush=True)
    art = Image.fromarray(np.clip(acc / np.maximum(wsum, 1e-6), 0, 255).astype(np.uint8))
    art.save(out / "art.png")
    print(f"art -> {out / 'art.png'}")


if __name__ == "__main__":
    main()
