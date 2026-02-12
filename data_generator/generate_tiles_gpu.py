#!/usr/bin/env python3
"""
GPU-Accelerated Spring Foliage Tile Generator

Uses CuPy and CUDA to accelerate tile generation from SpringBloom_30yr.tif.
Designed for NVIDIA GPUs (tested on RTX 3080).

Performance: ~100-1000× faster than CPU implementation.
"""

import os
import math
import numpy as np
from pathlib import Path
from PIL import Image
import rasterio
from rasterio.crs import CRS
import mercantile
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor
import cupy as cp
from cupyx.scipy.ndimage import map_coordinates

# Configuration
GEOTIFF_PATH = "../client/public/SpringBloom_30yr.tif"
OUTPUT_DIR = "../client/public/tiles"
MIN_ZOOM = 4
MAX_ZOOM = 8
TILE_SIZE = 256

# Day range and interval
DAY_START = 53
DAY_END = 62
DAY_INTERVAL = 1

# Batch size for parallel tile processing
BATCH_SIZE = 32

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


def web_mercator_to_geographic(x, y):
    """
    Convert Web Mercator (EPSG:3857) coordinates to WGS84 lat/lon.
    
    Args:
        x, y: CuPy arrays of Web Mercator coordinates (meters)
    
    Returns:
        lon, lat: CuPy arrays of geographic coordinates (degrees)
    """
    lon = (x / 20037508.34) * 180.0
    lat = (y / 20037508.34) * 180.0
    lat = 180.0 / cp.pi * (2.0 * cp.arctan(cp.exp(lat * cp.pi / 180.0)) - cp.pi / 2.0)
    return lon, lat


def geographic_to_pixel(lon, lat, transform, width, height):
    """
    Convert geographic coordinates to source raster pixel coordinates.
    
    Args:
        lon, lat: CuPy arrays of geographic coordinates (degrees)
        transform: Affine transform from rasterio
        width, height: Source raster dimensions
    
    Returns:
        col, row: CuPy arrays of pixel coordinates (floats for interpolation)
    """
    # Affine transform: x = a * col + b * row + c
    #                   y = d * col + e * row + f
    # Inverse: col = (x - c - b * row) / a
    #          row = (y - f - d * col) / e
    # For geographic rasters, typically b=d=0, so:
    # col = (lon - c) / a
    # row = (lat - f) / e
    
    a, b, c, d, e, f = transform.a, transform.b, transform.c, transform.d, transform.e, transform.f
    
    # Inverse transform
    col = (lon - c) / a
    row = (lat - f) / e
    
    return col, row


def classify_foliage_gpu(spring_days, current_day):
    """
    GPU-accelerated foliage classification.
    
    Args:
        spring_days: CuPy array (H, W) of day-of-year values (1-365)
        current_day: Current day of year being rendered (60-140)
    
    Returns:
        RGBA CuPy array (H, W, 4) with colors applied to each pixel
    """
    # Calculate days difference
    days_diff = current_day - spring_days
    
    # Initialize RGBA array
    rgba = cp.zeros((*spring_days.shape, 4), dtype=cp.uint8)
    
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


def render_tile_gpu(source_data_gpu, transform, src_width, src_height, tile, current_day):
    """
    Render a single tile using GPU acceleration.
    
    Args:
        source_data_gpu: CuPy array of source GeoTIFF data (on GPU)
        transform: Affine transform from source raster
        src_width, src_height: Source raster dimensions
        tile: mercantile.Tile object (z, x, y coordinates)
        current_day: Day of year to render (60-140)
    
    Returns:
        NumPy array (256, 256, 4) RGBA or None if tile is empty
    """
    # Get tile bounds in Web Mercator
    bounds = mercantile.bounds(tile)
    west, south, east, north = bounds.west, bounds.south, bounds.east, bounds.north
    
    # Convert to Web Mercator meters
    west_m = west * 20037508.34 / 180.0
    east_m = east * 20037508.34 / 180.0
    south_m = math.log(math.tan((90 + south) * math.pi / 360.0)) / (math.pi / 180.0)
    south_m = south_m * 20037508.34 / 180.0
    north_m = math.log(math.tan((90 + north) * math.pi / 360.0)) / (math.pi / 180.0)
    north_m = north_m * 20037508.34 / 180.0
    
    # Create pixel grid for this tile (256x256)
    x_coords = cp.linspace(west_m, east_m, TILE_SIZE, dtype=cp.float32)
    y_coords = cp.linspace(north_m, south_m, TILE_SIZE, dtype=cp.float32)
    x_grid, y_grid = cp.meshgrid(x_coords, y_coords)
    
    # Convert Web Mercator to Geographic
    lon_grid, lat_grid = web_mercator_to_geographic(x_grid, y_grid)
    
    # Convert Geographic to source pixel coordinates
    col_grid, row_grid = geographic_to_pixel(lon_grid, lat_grid, transform, src_width, src_height)
    
    # Stack coordinates for map_coordinates (expects [2, H, W])
    coords = cp.stack([row_grid, col_grid])
    
    # Sample source data using bilinear interpolation
    # map_coordinates expects coordinates in [dim, ...] format
    sampled = map_coordinates(source_data_gpu, coords, order=1, mode='constant', cval=0)
    
    # Check if tile has valid data
    valid_mask = (sampled >= 1) & (sampled <= 365)
    if not cp.any(valid_mask):
        return None  # Skip empty tiles
    
    # Classify and color
    rgba = classify_foliage_gpu(sampled, current_day)
    
    # Transfer to CPU
    rgba_cpu = cp.asnumpy(rgba)
    
    # Ensure it's C-contiguous (though asnumpy usually is)
    if not rgba_cpu.flags['C_CONTIGUOUS']:
        rgba_cpu = np.ascontiguousarray(rgba_cpu)
        
    return rgba_cpu


def save_tile(tile_data, tile, day_dir):
    """
    Save a tile to disk (runs in thread pool to avoid blocking GPU).
    
    Args:
        tile_data: NumPy array (256, 256, 4) RGBA
        tile: mercantile.Tile object
        day_dir: Base directory for this day
    """
    zoom_dir = day_dir / str(tile.z)
    tile_dir = zoom_dir / str(tile.x)
    tile_dir.mkdir(parents=True, exist_ok=True)
    
    tile_path = tile_dir / f"{tile.y}.png"
    img = Image.fromarray(tile_data, mode='RGBA')
    # Disabling optimization (optimize=False) significantly speeds up generation by 
    # skipping extra CPU-intensive compression passes. This also helps avoid 
    # potential serving/decoding issues on development servers.
    img.save(tile_path, "PNG", optimize=False)


def generate_tiles_for_day_gpu(source_data_gpu, transform, src_width, src_height, day, output_base_dir):
    """
    Generate all tiles for a specific day using GPU acceleration.
    
    Args:
        source_data_gpu: CuPy array of source data (on GPU)
        transform: Affine transform from source raster
        src_width, src_height: Source raster dimensions
        day: Day of year to generate (60-140)
        output_base_dir: Base output directory
    """
    day_dir = Path(output_base_dir) / f"day_{day:03d}"
    
    print(f"\n📅 Generating tiles for Day {day} (GPU)")
    
    # Thread pool for async disk I/O
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = []
        
        for zoom in range(MIN_ZOOM, MAX_ZOOM + 1):
            # Calculate tiles for this zoom level
            # Use approximate US bounds
            tiles = list(mercantile.tiles(-125, 24, -66, 50, zoom))
            
            print(f"  Zoom {zoom}: {len(tiles)} tiles")
            
            # Process tiles in batches
            for i in tqdm(range(0, len(tiles), BATCH_SIZE), desc=f"    z{zoom}", leave=False):
                batch = tiles[i:i+BATCH_SIZE]
                
                for tile in batch:
                    tile_data = render_tile_gpu(source_data_gpu, transform, src_width, src_height, tile, day)
                    
                    if tile_data is not None:
                        # Submit save task to thread pool
                        future = executor.submit(save_tile, tile_data, tile, day_dir)
                        futures.append(future)
        
        # Wait for all saves to complete
        for future in futures:
            future.result()


def main():
    """Main GPU tile generation pipeline."""
    print("🌸 GPU-Accelerated Spring Foliage Tile Generator")
    print("=" * 50)
    
    # Check CUDA availability
    try:
        device = cp.cuda.Device()
        props = cp.cuda.runtime.getDeviceProperties(device.id)
        print(f"🎮 GPU: {props['name'].decode()}")
        print(f"💾 VRAM: {device.mem_info[1] / 1e9:.1f} GB total")
    except Exception as e:
        print(f"❌ Error: CUDA not available. {e}")
        return
    
    # Verify input file exists
    geotiff_path = Path(GEOTIFF_PATH)
    if not geotiff_path.exists():
        print(f"❌ Error: GeoTIFF not found at {geotiff_path}")
        return
    
    print(f"📂 Input: {geotiff_path}")
    print(f"📂 Output: {OUTPUT_DIR}")
    print(f"🔢 Zoom levels: {MIN_ZOOM} to {MAX_ZOOM}")
    print(f"📅 Day range: {DAY_START} to {DAY_END} (every {DAY_INTERVAL} days)")
    
    # Load source GeoTIFF
    print("\n📊 Loading source data to GPU...")
    with rasterio.open(geotiff_path) as src:
        print(f"   Resolution: {src.width} x {src.height}")
        print(f"   CRS: {src.crs}")
        print(f"   Bounds: {src.bounds}")
        
        # Read entire raster to CPU first
        source_data_cpu = src.read(1)
        transform = src.transform
        src_width = src.width
        src_height = src.height
    
    # Transfer to GPU
    source_data_gpu = cp.array(source_data_cpu, dtype=cp.float32)
    print(f"   ✅ Data loaded to GPU ({source_data_gpu.nbytes / 1e6:.1f} MB)")
    
    # Generate tiles for each day
    days = range(DAY_START, DAY_END + 1, DAY_INTERVAL)
    total_days = len(list(days))
    
    print(f"\n🚀 Generating {total_days} tile sets...")
    
    for day in days:
        generate_tiles_for_day_gpu(source_data_gpu, transform, src_width, src_height, day, OUTPUT_DIR)
    
    print("\n✅ Tile generation complete!")
    print(f"📁 Output location: {Path(OUTPUT_DIR).absolute()}")


if __name__ == "__main__":
    main()
