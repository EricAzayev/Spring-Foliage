#!/usr/bin/env python3
"""
Spring Foliage Single Image Generator

Creates one high-resolution image per day covering the entire US
with 2x2 mile grid cells, matching the detail of CPU mode.
"""

import numpy as np
from pathlib import Path
from PIL import Image
import rasterio
from tqdm import tqdm

# Configuration
GEOTIFF_PATH = "../client/public/SpringBloom_30yr.tif"
OUTPUT_DIR = "../client/public/foliage_images"
TILE_SIZE = 256

# Day range and interval
DAY_START = 53
DAY_END = 62
DAY_INTERVAL = 1

# Grid cell size in miles (matching CPU mode precisely)
CELL_SIZE_MILES = 2

# US Bounds (matching CPU mode)
US_BBOX = [-130, 24, -65, 50]  # [west, south, east, north]

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


def miles_to_degrees_lat(miles):
    """Convert miles to degrees latitude (approximately)."""
    return miles / 69.0  # 1 degree latitude ≈ 69 miles


def miles_to_degrees_lon(miles, latitude):
    """Convert miles to degrees longitude at given latitude."""
    import math
    return miles / (69.0 * math.cos(math.radians(latitude)))


def geographic_to_pixel(lon, lat, transform, width, height):
    """Convert geographic coordinates to source raster pixel coordinates."""
    a, b, c, d, e, f = transform.a, transform.b, transform.c, transform.d, transform.e, transform.f
    col = (lon - c) / a
    row = (lat - f) / e
    return col, row


def get_foliage_color(days_diff):
    """Get RGBA color tuple for foliage stage based on days difference."""
    if days_diff < -15:
        return (*FOLIAGE_COLORS["none"], 255)
    elif days_diff < -10:
        return (*FOLIAGE_COLORS["budding"], 255)
    elif days_diff < -5:
        return (*FOLIAGE_COLORS["firstLeaf"], 255)
    elif days_diff < 3:
        return (*FOLIAGE_COLORS["firstBloom"], 255)
    elif days_diff < 10:
        return (*FOLIAGE_COLORS["peakBloom"], 255)
    elif days_diff < 20:
        return (*FOLIAGE_COLORS["canopy"], 255)
    else:
        return (*FOLIAGE_COLORS["postBloom"], 255)


def generate_day_image(source_data, transform, src_width, src_height, day, output_dir):
    """
    Generate a single high-resolution image for the entire US for a specific day.
    Uses 2x2 mile grid cells matching CPU mode.
    """
    west, south, east, north = US_BBOX
    
    # Calculate grid cell sizes in degrees
    center_lat = (south + north) / 2
    cell_lon_size = miles_to_degrees_lon(CELL_SIZE_MILES, center_lat)
    cell_lat_size = miles_to_degrees_lat(CELL_SIZE_MILES)
    
    # Calculate image dimensions based on grid cells
    num_lon_cells = int((east - west) / cell_lon_size) + 1
    num_lat_cells = int((north - south) / cell_lat_size) + 1
    
    print(f"  Image size: {num_lon_cells} x {num_lat_cells} pixels ({CELL_SIZE_MILES}mi cells)")
    print(f"  Approximate dimensions: {num_lon_cells * CELL_SIZE_MILES:.0f} x {num_lat_cells * CELL_SIZE_MILES:.0f} miles")
    
    # Create blank RGBA image
    img_array = np.zeros((num_lat_cells, num_lon_cells, 4), dtype=np.uint8)
    
    # Generate grid cells
    print(f"  Generating {num_lon_cells * num_lat_cells:,} grid cells...")
    
    for i in tqdm(range(num_lon_cells), desc="  Processing longitude", leave=False):
        lon = west + (i * cell_lon_size)
        
        for j in range(num_lat_cells):
            lat = south + (j * cell_lat_size)
            
            # Sample GeoTIFF at cell center
            center_lon = lon + cell_lon_size / 2
            center_lat = lat + cell_lat_size / 2
            
            col, row = geographic_to_pixel(center_lon, center_lat, transform, src_width, src_height)
            col_int = int(col)
            row_int = int(row)
            
            # Check bounds and sample
            if 0 <= col_int < src_width and 0 <= row_int < src_height:
                spring_day = source_data[row_int, col_int]
                
                # Skip invalid data
                if 1 <= spring_day <= 365:
                    # Classify foliage stage
                    days_diff = day - spring_day
                    color = get_foliage_color(days_diff)
                    
                    # Set pixel color (Y is flipped for image)
                    pixel_y = num_lat_cells - 1 - j
                    img_array[pixel_y, i] = color
    
    # Save image
    output_path = Path(output_dir) / f"day_{day:03d}.png"
    img = Image.fromarray(img_array, mode='RGBA')
    img.save(output_path, "PNG", optimize=False)
    
    print(f"  ✅ Saved: {output_path}")
    
    return output_path


def main():
    """Main image generation pipeline."""
    print("🌸 Spring Foliage Single Image Generator")
    print("=" * 50)
    
    # Verify input file exists
    geotiff_path = Path(GEOTIFF_PATH)
    if not geotiff_path.exists():
        print(f"❌ Error: GeoTIFF not found at {geotiff_path}")
        return
    
    # Create output directory
    output_dir = Path(OUTPUT_DIR)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"📂 Input: {geotiff_path}")
    print(f"📂 Output: {output_dir}")
    print(f"📅 Day range: {DAY_START} to {DAY_END} (every {DAY_INTERVAL} days)")
    print(f"📏 Cell size: {CELL_SIZE_MILES} miles")
    print(f"🗺️  Coverage: US bounds {US_BBOX}")
    
    # Load source GeoTIFF
    print("\n📊 Loading source data...")
    with rasterio.open(geotiff_path) as src:
        print(f"   Resolution: {src.width} x {src.height}")
        print(f"   CRS: {src.crs}")
        print(f"   Bounds: {src.bounds}")
        
        source_data = src.read(1)
        transform = src.transform
        src_width = src.width
        src_height = src.height
    
    print(f"   ✅ Data loaded ({source_data.nbytes / 1e6:.1f} MB)")
    
    # Generate images for each day
    days = range(DAY_START, DAY_END + 1, DAY_INTERVAL)
    total_days = len(list(days))
    
    print(f"\n🚀 Generating {total_days} images...")
    
    for day in days:
        print(f"\n📅 Day {day}:")
        generate_day_image(source_data, transform, src_width, src_height, day, output_dir)
    
    print("\n✅ Image generation complete!")
    print(f"📁 Output location: {output_dir.absolute()}")
    print("\nNext steps:")
    print("1. Update Map.jsx to use these images as overlays instead of tiles")
    print("2. Images will automatically scale with zoom, revealing grid detail")


if __name__ == "__main__":
    main()
