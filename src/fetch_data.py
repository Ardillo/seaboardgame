"""Download the Natural Earth data the board is built from (public domain)."""
import io
import urllib.request
import zipfile
from pathlib import Path

from board_common import load_config, parse_args

FILES = {
    "ne_50m_land": "https://naciscdn.org/naturalearth/50m/physical/ne_50m_land.zip",
    "ne_10m_geography_marine_polys":
        "https://naciscdn.org/naturalearth/10m/physical/ne_10m_geography_marine_polys.zip",
    "ne_50m_antarctic_ice_shelves_polys":
        "https://naciscdn.org/naturalearth/50m/physical/ne_50m_antarctic_ice_shelves_polys.zip",
    "NE2_50M_SR_W": "https://naciscdn.org/naturalearth/50m/raster/NE2_50M_SR_W.zip",
}


def main():
    cfg = load_config(parse_args(__doc__))
    data = Path(cfg["data_dir"])
    data.mkdir(parents=True, exist_ok=True)
    for name, url in FILES.items():
        target = data / name
        if target.exists():
            print(f"have  {name}")
            continue
        print(f"fetch {url}")
        blob = urllib.request.urlopen(url).read()
        zipfile.ZipFile(io.BytesIO(blob)).extractall(target)
    print("done:", data)


if __name__ == "__main__":
    main()
