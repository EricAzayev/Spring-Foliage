#!/usr/bin/env python3
"""
Spring Foliage Tile Generator

Generates pre-rendered map tiles from SpringBloom_30yr.tif for discrete time steps.
Output: tiles/day_XXX/{z}/{x}/{y}.png for efficient browser-based visualization.

See README.md for detailed documentation.
"""

import os
import math
import numpy as np
from pathlib import Path
from PIL import Image
import rasterio
from rasterio.warp import reproject, Resampling, calculate_default_transform
from rasterio.crs import CRS
import mercantile
from tqdm import tqdm


# Configuration
GEOTIFF_PATH = "../client/public/SpringBloom_30yr.tif"
OUTPUT_DIR = "../client/public/tiles"
MIN_ZOOM = 4
MAX_ZOOM = 12
TILE_SIZE = 256

# Day range and interval
DAY_START = 60
DAY_END = 140
DAY_INTERVAL = 5

# Foliage color scheme (RGB)
FOLIAGE_COLORS = {
    "none": (75, 54, 33),         # #4B3621 - Dark brown
    "budding": (166, 123, 91),     # #A67B5B - Light brown
    "firstLeaf": (201, 217, 111),  # #C9D96F - Yellow-green
    "firstBloom": (218, 112, 214), # #DA70D6 - Orchid/purplish pink
    "peakBloom": (128, 0, 128),    # #800080 - Purple
    "canopy": (173, 255, 47),      # #ADFF2F - Green-yellow
    "postBloom": (0, 100, 0),      # #006400 - Dark green
}


def classify_foliage_vectorized(spring_days, current_day):
    """
    Vectorized foliage classification for entire arrays.
    
    Uses numpy boolean masking to classify all pixels simultaneously instead
    of looping. This is ~100× faster than iterating pixel-by-pixel.
    
    Args:
        spring_days: numpy array (H, W) of day-of-year values (1-365) from GeoTIFF
        current_day: Current day of year being rendered (60-140)
    
    Returns:
        RGBA numpy array (H, W, 4) with colors applied to each pixel
    """
    # Calculate days difference
    days_diff = current_day - spring_days
    
    # Initialize RGBA array
    rgba = np.zeros((*spring_days.shape, 4), dtype=np.uint8)
    
    # Create masks for each stage
    invalid = (spring_days < 1) | (spring_days > 365)
    none_mask = (days_diff < -15) & ~invalid
    budding_mask = (days_diff >= -15) & (days_diff < -10)
    firstLeaf_mask = (days_diff >= -10) & (days_diff < -5)
    firstBloom_mask = (days_diff >= -5) & (days_diff < 3)
    peakBloom_mask = (days_diff >= 3) & (days_diff < 10)
    canopy_mask = (days_diff >= 10) & (days_diff < 20)
    postBloom_mask = (days_diff >= 20) & ~invalid
    
    # Apply colors
    rgba[none_mask] = (*FOLIAGE_COLORS["none"], 255)
    rgba[budding_mask] = (*FOLIAGE_COLORS["budding"], 255)
    rgba[firstLeaf_mask] = (*FOLIAGE_COLORS["firstLeaf"], 255)
    rgba[firstBloom_mask] = (*FOLIAGE_COLORS["firstBloom"], 255)
    rgba[peakBloom_mask] = (*FOLIAGE_COLORS["peakBloom"], 255)
    rgba[canopy_mask] = (*FOLIAGE_COLORS["canopy"], 255)
    rgba[postBloom_mask] = (*FOLIAGE_COLORS["postBloom"], 255)
    rgba[invalid] = (0, 0, 0, 0)  # Transparent for invalid data
    
    return rgba


def get_tile_bounds(tile):
    """
    Get geographic bounds for a web mercator tile.
    
    Converts tile coordinates (z/x/y) to lat/lon bounding box.
    Uses mercantile library which implements the standard slippy map formula.
    """
    bounds = mercantile.bounds(tile)
    return bounds.west, bounds.south, bounds.east, bounds.north


def render_tile(src, tile, current_day):
    """
    Render a single tile by extracting and resampling from the source raster.
    
    PROCESS:
    1. Calculate tile's geographic bounds in Web Mercator (EPSG:3857)
    2. Reproject source data (GeoTIFF, likely WGS84) into tile space
    3. Use bilinear resampling to avoid pixelation and tile seams
    4. Classify reprojected bloom-day values into foliage colors
    5. Return 256×256 RGBA PNG or None if tile has no data
    
    WHY REPROJECT:
    - Source GeoTIFF: Geographic coordinates (lat/lon degrees)
    - Output tiles: Web Mercator (meters, distorted at poles)
    - Rasterio handles the math automatically
    
    Args:
        src: Open rasterio dataset (SpringBloom_30yr.tif)
        tile: mercantile.Tile object (z, x, y coordinates)
        current_day: Day of year to render (60-140)
    
    Returns:
        PIL Image (RGBA, 256×256) or None if tile contains no valid data
    """
    # Get tile bounds in Web Mercator
    west, south, east, north = get_tile_bounds(tile)
    
    # Create output array (will hold reprojected bloom-day values)
    output = np.zeros((TILE_SIZE, TILE_SIZE), dtype=np.float32)
    
    # Calculate transformation matrix from source CRS to Web Mercator
    # This determines how to map source pixels into our 256×256 tile
    transform, width, height = calculate_default_transform(
        src.crs,
        CRS.from_epsg(3857),  # Web Mercator
        TILE_SIZE,
        TILE_SIZE,
        left=west,
        bottom=south,
        right=east,
        top=north
    )
    
    # Reproject source GeoTIFF data into this tile's coordinate space
    # This handles:
    # - Coordinate system conversion (WGS84 → Web Mercator)
    # - Scaling (large raster → 256×256 tile)
    # - Resampling (bilinear = smooth, no blocky edges)
    reproject(
        source=rasterio.band(src, 1),
        destination=output,
        src_transform=src.transform,
        src_crs=src.crs,
        dst_transform=transform,
        dst_crs=CRS.from_epsg(3857),
        resampling=Resampling.bilinear
    )
    
    # Check if tile has valid data (GeoTIFF uses 1-365 for day of year)
    # Values outside this range = NoData (ocean, Canada, Mexico, etc.)
    valid_mask = (output >= 1) & (output <= 365)
    if not valid_mask.any():
        return None  # Skip empty tiles to save storage
    
    # Apply foliage colors using vectorized numpy operations
    # This classifies all 65,536 pixels at once (not in a loop!)
    rgba = classify_foliage_vectorized(output, current_day)
    
    # Convert to PIL Image
    img = Image.fromarray(rgba, mode='RGBA')
    return img


def generate_tiles_for_day(src, day, output_base_dir):
    """
    Generate all tiles for a specific day across all zoom levels.
    
    ZOOM LEVEL LOGIC:
    - Low zoom (4-6): Fewer tiles, covers whole continent
    - High zoom (10-12): Many tiles, shows local detail
    - Each zoom level doubles the tiles in each dimension (4× total tiles)
    
    TILE COVERAGE:
    - Uses mercantile to calculate which tiles intersect the source bounds
    - Only generates tiles that overlap continental US
    - Skips empty tiles (e.g., ocean-only areas) to save space
    
    Args:
        src: Open rasterio dataset (SpringBloom_30yr.tif)
        day: Day of year to generate (60-140)
        output_base_dir: Base output directory (e.g., '../client/public/tiles')
    """
    day_dir = Path(output_base_dir) / f"day_{day:03d}"
    
    print(f"\n📅 Generating tiles for Day {day}")
    
    # Get source bounds in lat/lon (will use to determine which tiles to generate)
    bounds = src.bounds
    west, south, east, north = bounds.left, bounds.bottom, bounds.right, bounds.top
    
    # Generate tiles for each zoom level (4 → 5 → 6 ... → 12)
    for zoom in range(MIN_ZOOM, MAX_ZOOM + 1):
        zoom_dir = day_dir / str(zoom)
        
        # Calculate which tiles (x, y) intersect our source data at this zoom
        # mercantile.tiles() returns all tiles touching the lat/lon bounding box
        tiles = list(mercantile.tiles(west, south, east, north, zoom))
        
        print(f"  Zoom {zoom}: {len(tiles)} tiles")
        
        for tile in tqdm(tiles, desc=f"    z{zoom}", leave=False):
            img = render_tile(src, tile, day)
            
            if img is None:
                continue  # Skip empty tiles
            
            # Create directory structure
            tile_dir = zoom_dir / str(tile.x)
            tile_dir.mkdir(parents=True, exist_ok=True)
            
            # Save tile
            tile_path = tile_dir / f"{tile.y}.png"
            img.save(tile_path, "PNG", optimize=True)


def main():
    """Main tile generation pipeline."""
    print("🌸 Spring Foliage Tile Generator")
    print("=" * 50)
    
    # Verify input file exists
    geotiff_path = Path(GEOTIFF_PATH)
    if not geotiff_path.exists():
        print(f"❌ Error: GeoTIFF not found at {geotiff_path}")
        return
    
    print(f"📂 Input: {geotiff_path}")
    print(f"📂 Output: {OUTPUT_DIR}")
    print(f"🔢 Zoom levels: {MIN_ZOOM} to {MAX_ZOOM}")
    print(f"📅 Day range: {DAY_START} to {DAY_END} (every {DAY_INTERVAL} days)")
    
    # Open source GeoTIFF
    with rasterio.open(geotiff_path) as src:
        print(f"\n📊 Source info:")
        print(f"   Resolution: {src.width} x {src.height}")
        print(f"   CRS: {src.crs}")
        print(f"   Bounds: {src.bounds}")
        
        # Generate tiles for each day
        days = range(DAY_START, DAY_END + 1, DAY_INTERVAL)
        total_days = len(list(days))
        
        print(f"\n🚀 Generating {total_days} tile sets...")
        
        for day in days:
            generate_tiles_for_day(src, day, OUTPUT_DIR)
    
    print("\n✅ Tile generation complete!")
    print(f"📁 Output location: {Path(OUTPUT_DIR).absolute()}")


if __name__ == "__main__":
    main()
