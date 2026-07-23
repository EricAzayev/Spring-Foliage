#!/usr/bin/env python3
"""
Daily snow depth surface generation via Regression Kriging.

Pipeline summary:
1) Ingest station text files (NOHRSC format) and group by report day.
2) Reproject stations to US equal-area projection (ESRI:102003 fallback EPSG:5070).
3) Fit SnowDepth ~ Elevation linear regression per day.
4) Krige residuals with Ordinary Kriging and add back to regression base map.
5) Clip/mask to CONUS polygon, write daily GeoTIFF outputs.
6) Render hillshade + transparent snow overlay PNGs.
"""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

import geopandas as gpd
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import rasterio
from matplotlib.colors import LinearSegmentedColormap, Normalize
from matplotlib.colors import LightSource
from pykrige.ok import OrdinaryKriging
from pyproj import CRS
from rasterio.features import rasterize
from rasterio.mask import mask
from rasterio.warp import Resampling, calculate_default_transform, reproject
from shapely.geometry import Point
from sklearn.linear_model import LinearRegression


STATION_COLUMNS = [
    "Station_Id",
    "Name",
    "Latitude",
    "Longitude",
    "Elevation",
    "Physical_Element",
    "DateTime_Report(UTC)",
    "Amount",
    "Units",
    "Zip_Code",
]

MAX_KRIGING_POINTS = 400


def _pick_conus_albers() -> CRS:
    """Prefer ESRI:102003 and fall back to EPSG:5070 when unavailable."""
    try:
        return CRS.from_user_input("ESRI:102003")
    except Exception:
        return CRS.from_epsg(5070)


CONUS_ALBERS = _pick_conus_albers()
WGS84 = CRS.from_epsg(4326)


@dataclass
class GridSpec:
    transform: rasterio.Affine
    width: int
    height: int
    crs: CRS
    dem: np.ndarray


def parse_station_file(path: Path) -> pd.DataFrame:
    """Parse NOHRSC text file with first-line disclaimer and pipe-delimited rows."""
    raw = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    if len(raw) < 3:
        return pd.DataFrame(columns=STATION_COLUMNS)

    header = [h for h in raw[1].split("|") if h]
    if not header:
        header = STATION_COLUMNS

    rows = []
    for line in raw[2:]:
        if not line.strip():
            continue
        parts = line.split("|")
        if parts and parts[-1] == "":
            parts = parts[:-1]
        if len(parts) < len(header):
            continue
        rows.append(parts[: len(header)])

    if not rows:
        return pd.DataFrame(columns=header)

    df = pd.DataFrame(rows, columns=header)
    rename = {"Amount": "snow_cm", "Elevation": "station_elevation_m"}
    df = df.rename(columns=rename)

    if "station_elevation_m" in df.columns:
        df["station_elevation_m"] = df["station_elevation_m"].astype(str).str.extract(r"([-+]?\d*\.?\d+)", expand=False)

    for c in ["Latitude", "Longitude", "station_elevation_m", "snow_cm"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")

    if "DateTime_Report(UTC)" in df.columns:
        df["report_dt"] = pd.to_datetime(df["DateTime_Report(UTC)"], errors="coerce", utc=True)
        df["report_day"] = df["report_dt"].dt.date
    else:
        df["report_day"] = pd.NaT

    df = df.dropna(subset=["Latitude", "Longitude", "snow_cm", "station_elevation_m", "report_day"])
    return df


def load_station_data(station_dir: Path) -> pd.DataFrame:
    dfs = [parse_station_file(p) for p in sorted(station_dir.glob("snowdepth_*_m.txt"))]
    if not dfs:
        raise FileNotFoundError(f"No station files found in {station_dir}")
    full = pd.concat(dfs, ignore_index=True)
    return full


def to_projected_gdf(df: pd.DataFrame) -> gpd.GeoDataFrame:
    gdf = gpd.GeoDataFrame(
        df,
        geometry=[Point(xy) for xy in zip(df["Longitude"], df["Latitude"])],
        crs=WGS84,
    )
    return gdf.to_crs(CONUS_ALBERS)


def load_conus_polygon(states_geojson: Path) -> gpd.GeoDataFrame:
    states = gpd.read_file(states_geojson)
    if "name" not in states.columns and "NAME" in states.columns:
        states = states.rename(columns={"NAME": "name"})
    conus = states[~states["name"].isin(["Alaska", "Hawaii", "Puerto Rico"])].copy()
    if conus.empty:
        raise ValueError("US states polygon did not contain CONUS features.")
    conus = conus.to_crs(CONUS_ALBERS)
    conus_union = conus.dissolve()
    conus_union = conus_union.set_geometry(conus_union.geometry.buffer(0))
    return conus_union


def build_projected_dem_grid(dem_path: Path, target_resolution_m: float) -> GridSpec:
    with rasterio.open(dem_path) as src:
        transform, width, height = calculate_default_transform(
            src.crs,
            CONUS_ALBERS,
            src.width,
            src.height,
            *src.bounds,
            resolution=target_resolution_m,
        )

        dst = np.full((height, width), np.nan, dtype=np.float32)

        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=transform,
            dst_crs=CONUS_ALBERS,
            resampling=Resampling.bilinear,
            src_nodata=src.nodata,
            dst_nodata=np.nan,
        )

    return GridSpec(transform=transform, width=width, height=height, crs=CONUS_ALBERS, dem=dst)


def rasterize_conus_mask(conus_polygon: gpd.GeoDataFrame, grid: GridSpec) -> np.ndarray:
    geoms = [(geom, 1) for geom in conus_polygon.geometry if geom is not None]
    mask_arr = rasterize(
        geoms,
        out_shape=(grid.height, grid.width),
        transform=grid.transform,
        fill=0,
        all_touched=True,
        dtype="uint8",
    )
    return mask_arr.astype(bool)


def sample_dem_at_points(grid: GridSpec, gdf: gpd.GeoDataFrame) -> np.ndarray:
    inv = ~grid.transform
    vals = np.full(len(gdf), np.nan, dtype=np.float32)
    for i, geom in enumerate(gdf.geometry):
        col_f, row_f = inv * (geom.x, geom.y)
        row, col = int(np.floor(row_f)), int(np.floor(col_f))
        if 0 <= row < grid.height and 0 <= col < grid.width:
            vals[i] = grid.dem[row, col]
    return vals


def fit_regression_kriging(day_gdf: gpd.GeoDataFrame, grid: GridSpec, conus_mask: np.ndarray) -> np.ndarray:
    station_dem = sample_dem_at_points(grid, day_gdf)
    y = day_gdf["snow_cm"].to_numpy(dtype=np.float32)

    valid = np.isfinite(station_dem) & np.isfinite(y)
    if valid.sum() < 3:
        raise ValueError("Need at least 3 valid stations for regression kriging.")

    X = station_dem[valid].reshape(-1, 1)
    yv = y[valid]

    reg = LinearRegression()
    reg.fit(X, yv)

    base = reg.predict(np.nan_to_num(grid.dem, nan=np.nanmedian(X)).reshape(-1, 1)).reshape(grid.height, grid.width)
    residuals = yv - reg.predict(X)

    used_points = day_gdf.loc[valid, "geometry"]
    px = np.array([p.x for p in used_points], dtype=float)
    py = np.array([p.y for p in used_points], dtype=float)

    if len(residuals) > MAX_KRIGING_POINTS:
        rng = np.random.default_rng(42)
        sample_idx = np.sort(rng.choice(len(residuals), size=MAX_KRIGING_POINTS, replace=False))
        px = px[sample_idx]
        py = py[sample_idx]
        residuals = residuals[sample_idx]

    xs = grid.transform.c + (np.arange(grid.width) + 0.5) * grid.transform.a
    ys = grid.transform.f + (np.arange(grid.height) + 0.5) * grid.transform.e

    try:
        ok = OrdinaryKriging(
            px,
            py,
            residuals,
            variogram_model="spherical",
            verbose=False,
            enable_plotting=False,
            coordinates_type="euclidean",
        )
        z_resid, _ = ok.execute("grid", xs, ys)
        resid_grid = np.asarray(z_resid, dtype=np.float32)
    except Exception:
        resid_grid = np.zeros((grid.height, grid.width), dtype=np.float32)

    snow = base + resid_grid
    snow = np.clip(snow, 0.0, None)
    snow[~np.isfinite(grid.dem)] = np.nan
    snow[~conus_mask] = np.nan
    return snow.astype(np.float32)


def write_raster(path: Path, arr: np.ndarray, grid: GridSpec) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "count": 1,
        "width": grid.width,
        "height": grid.height,
        "crs": grid.crs,
        "transform": grid.transform,
        "compress": "lzw",
        "nodata": np.nan,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(arr, 1)


def render_overlay_png(path: Path, snow: np.ndarray, dem: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    dem_filled = np.where(np.isfinite(dem), dem, np.nanmedian(dem[np.isfinite(dem)]))
    ls = LightSource(azdeg=315, altdeg=35)
    hill = ls.hillshade(dem_filled, vert_exag=1.5, dx=1, dy=1)

    ramp = LinearSegmentedColormap.from_list(
        "snow_ramp",
        ["#819E8D", "#459194", "#2F3E8B", "#4E1D7D"],
        N=256,
    )
    vmax = np.nanpercentile(snow, 99) if np.isfinite(snow).any() else 1.0
    norm = Normalize(vmin=0.0, vmax=max(vmax, 1.0))

    rgba = ramp(norm(np.nan_to_num(snow, nan=0.0)))

    # Transparent where snow is negligible (< 2 cm), then ramp opacity organically.
    alpha = np.clip((np.nan_to_num(snow, nan=0.0) - 2.0) / 40.0, 0.0, 0.8)
    rgba[..., 3] = alpha

    fig, ax = plt.subplots(figsize=(10, 7), dpi=200)
    ax.imshow(hill, cmap="gray", interpolation="nearest")
    ax.imshow(rgba, interpolation="nearest")
    ax.axis("off")

    fig.savefig(path, bbox_inches="tight", pad_inches=0, transparent=True)
    plt.close(fig)


def day_suffix(day_value) -> str:
    return pd.Timestamp(day_value).strftime("%Y%m%d")


def run_pipeline(
    station_dir: Path,
    dem_path: Path,
    states_geojson: Path,
    out_raster_dir: Path,
    out_png_dir: Path,
    resolution_m: float,
) -> None:
    stations = load_station_data(station_dir)
    stations_gdf = to_projected_gdf(stations)

    conus = load_conus_polygon(states_geojson)
    grid = build_projected_dem_grid(dem_path, resolution_m)
    conus_mask = rasterize_conus_mask(conus, grid)

    grouped = stations_gdf.groupby("report_day", sort=True)

    for day, day_gdf in grouped:
        # Basic outlier control for daily station reports.
        day_gdf = day_gdf[(day_gdf["snow_cm"] >= 0) & (day_gdf["snow_cm"] <= 1200)].copy()
        if len(day_gdf) < 3:
            continue

        try:
            snow_surface = fit_regression_kriging(day_gdf, grid, conus_mask)
        except ValueError:
            continue

        suffix = day_suffix(day)
        raster_path = out_raster_dir / f"snowdepth_{suffix}.tif"
        png_path = out_png_dir / f"snowdepth_{suffix}_overlay.png"

        write_raster(raster_path, snow_surface, grid)
        render_overlay_png(png_path, snow_surface, grid.dem)

        print(f"Wrote: {raster_path}")
        print(f"Wrote: {png_path}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Daily snow interpolation using regression kriging + DEM covariate.")
    p.add_argument(
        "--station-dir",
        type=Path,
        default=Path("client/public/snow_data"),
        help="Directory containing snowdepth_YYYYMMDD06_m.txt files.",
    )
    p.add_argument(
        "--dem",
        type=Path,
        default=Path("client/public/SpringBloom_30yr.tif"),
        help="DEM raster path used as the elevation covariate grid.",
    )
    p.add_argument(
        "--states-geojson",
        type=Path,
        default=Path("client/public/us-states.json"),
        help="US states polygon for CONUS masking.",
    )
    p.add_argument(
        "--resolution-m",
        type=float,
        default=5000.0,
        help="Output grid resolution in meters (e.g., 1000 or 5000).",
    )
    p.add_argument(
        "--out-raster-dir",
        type=Path,
        default=Path("snow_data_extraction/output/rasters"),
        help="Output directory for daily GeoTIFF rasters.",
    )
    p.add_argument(
        "--out-png-dir",
        type=Path,
        default=Path("snow_data_extraction/output/visualizations"),
        help="Output directory for hillshade-overlay PNG renders.",
    )
    return p


def main() -> None:
    args = build_parser().parse_args()
    run_pipeline(
        station_dir=args.station_dir,
        dem_path=args.dem,
        states_geojson=args.states_geojson,
        out_raster_dir=args.out_raster_dir,
        out_png_dir=args.out_png_dir,
        resolution_m=args.resolution_m,
    )


if __name__ == "__main__":
    main()
