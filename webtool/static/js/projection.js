// Map projection (port of Projection in ../src/board_common.py). Map mm, origin top-left.
export function makeProjection(b) {
  const width = b.inner_width_mm;
  const R = width / (2 * Math.PI);
  const miller = b.projection === "miller";
  const fy = (phi) => (miller ? 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * phi)) : phi);
  const fyInv = (y) => (miller ? 2.5 * Math.atan(Math.exp(0.8 * y)) - 0.625 * Math.PI : y);
  const rad = (d) => (d * Math.PI) / 180;
  const yTop = fy(rad(b.lat_north));
  const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
  return {
    forward(lon, lat) {
      const dl = wrap(lon - b.center_lon);
      return [width / 2 + R * rad(dl), R * (yTop - fy(rad(lat)))];
    },
    inverse(x, y) {
      const lon = wrap(b.center_lon + ((x - width / 2) / R) * (180 / Math.PI));
      const lat = (fyInv(yTop - y / R) * 180) / Math.PI;
      return [lon, lat];
    },
  };
}
