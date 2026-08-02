#!/usr/bin/env python3
"""
Generate web map tiles from daily regression-kriged snow rasters.

Input rasters:
    snow_data_generator/output/rasters/snowdepth_YYYYMMDD.tif

Output tiles:
  client/public/snow_tiles/YYYYMMDD/{z}/{x}/{y}.png
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
import json

import mercantile
import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject, transform_bounds

TILE_SIZE = 256
WEB_MERCATOR = CRS.from_epsg(3857)
SNOW_COLORS = np.array(
    [
        [0x81, 0x9E, 0x8D],
        [0x45, 0x91, 0x94],
        [0x2F, 0x3E, 0x8B],
        [0x4E, 0x1D, 0x7D],
    ],
    dtype=np.float32,
)
SNOW_STOPS_CM = np.array([2.0, 20.0, 60.0, 120.0], dtype=np.float32)
DAY_RE = re.compile(r"snowdepth_(\d{8})\.tif$")
EMPTY_TILE = Image.fromarray(np.zeros((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8), mode="RGBA")


def colorize_snow(depth_cm: np.ndarray) -> np.ndarray:
    """Convert depth grid into RGBA using the project snow ramp and transparency threshold."""
    rgba = np.zeros((depth_cm.shape[0], depth_cm.shape[1], 4), dtype=np.uint8)

    valid = np.isfinite(depth_cm)
    if not valid.any():
        return rgba

    d = np.where(valid, np.maximum(depth_cm, 0.0), 0.0).astype(np.float32)
    r = np.interp(d, SNOW_STOPS_CM, SNOW_COLORS[:, 0], left=SNOW_COLORS[0, 0], right=SNOW_COLORS[-1, 0])
    g = np.interp(d, SNOW_STOPS_CM, SNOW_COLORS[:, 1], left=SNOW_COLORS[0, 1], right=SNOW_COLORS[-1, 1])
    b = np.interp(d, SNOW_STOPS_CM, SNOW_COLORS[:, 2], left=SNOW_COLORS[0, 2], right=SNOW_COLORS[-1, 2])

    alpha = np.clip((d - 2.0) / 40.0, 0.0, 0.8) * 255.0

    snow_mask = valid & (d >= 2.0)
    rgba[..., 0] = np.where(snow_mask, r, 0).astype(np.uint8)
    rgba[..., 1] = np.where(snow_mask, g, 0).astype(np.uint8)
    rgba[..., 2] = np.where(snow_mask, b, 0).astype(np.uint8)
    rgba[..., 3] = np.where(snow_mask, alpha, 0).astype(np.uint8)
    return rgba


def render_tile(src: rasterio.io.DatasetReader, tile: mercantile.Tile) -> Image.Image:
    bounds = mercantile.bounds(tile)

    to_merc = Transformer.from_crs(4326, 3857, always_xy=True)
    west, south = to_merc.transform(bounds.west, bounds.south)
    east, north = to_merc.transform(bounds.east, bounds.north)

    dst = np.full((TILE_SIZE, TILE_SIZE), np.nan, dtype=np.float32)
    dst_transform = from_bounds(west, south, east, north, TILE_SIZE, TILE_SIZE)

    reproject(
        source=rasterio.band(src, 1),
        destination=dst,
        src_transform=src.transform,
        src_crs=src.crs,
        src_nodata=src.nodata,
        dst_transform=dst_transform,
        dst_crs=WEB_MERCATOR,
        dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )

    if not np.isfinite(dst).any() or np.nanmax(dst) < 2.0:
        return EMPTY_TILE.copy()

    rgba = colorize_snow(dst)
    if rgba[..., 3].max() == 0:
        return EMPTY_TILE.copy()
    return Image.fromarray(rgba, mode="RGBA")


def generate_tiles_for_raster(raster_path: Path, output_root: Path, min_zoom: int, max_zoom: int) -> None:
    match = DAY_RE.search(raster_path.name)
    if not match:
        return
    day_key = match.group(1)

    with rasterio.open(raster_path) as src:
        west, south, east, north = transform_bounds(src.crs, CRS.from_epsg(4326), *src.bounds, densify_pts=21)

        for z in range(min_zoom, max_zoom + 1):
            tiles = mercantile.tiles(west, south, east, north, [z])
            for tile in tiles:
                img = render_tile(src, tile)

                out_path = output_root / day_key / str(tile.z) / str(tile.x) / f"{tile.y}.png"
                out_path.parent.mkdir(parents=True, exist_ok=True)
                img.save(out_path, "PNG", optimize=True)

    print(f"Generated snow tiles for {day_key}")


def write_manifest(output_root: Path, rasters: list[Path], min_zoom: int, max_zoom: int) -> None:
    dates = []
    for raster in rasters:
        match = DAY_RE.search(raster.name)
        if match:
            dates.append(match.group(1))

    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = output_root / "index.json"
    manifest_path.write_text(
        json.dumps(
            {
                "dates": dates,
                "minzoom": min_zoom,
                "maxzoom": max_zoom,
            },
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate web tiles from daily snow interpolation rasters.")
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=Path("snow_data_generator/output/rasters"),
        help="Directory containing snowdepth_YYYYMMDD.tif rasters.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("client/public/snow_tiles"),
        help="Output tile root directory.",
    )
    parser.add_argument("--min-zoom", type=int, default=4)
    parser.add_argument("--max-zoom", type=int, default=4)
    args = parser.parse_args()

    rasters = sorted(args.input_dir.glob("snowdepth_*.tif"))
    if not rasters:
        raise FileNotFoundError(f"No snow rasters found in {args.input_dir}")

    for raster in rasters:
        generate_tiles_for_raster(raster, args.output_dir, args.min_zoom, args.max_zoom)

    write_manifest(args.output_dir, rasters, args.min_zoom, args.max_zoom)


if __name__ == "__main__":
    main()
