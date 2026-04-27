#!/usr/bin/env python3
"""
GPU-Accelerated Spring Foliage Tile Generator with Fine-Grained Grid Cells

Creates tiles with 3-mile grid cells just like CPU mode, so zooming reveals more detail.
"""

import os
import io
import math
import requests
from dotenv import load_dotenv
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))
import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
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
MAX_ZOOM = 4  
TILE_SIZE = 256

# Supabase upload configuration
# Set UPLOAD_TO_SUPABASE=True and provide credentials via environment variables:
#   SUPABASE_URL=https://<project>.supabase.co
#   SUPABASE_SERVICE_KEY=<service_role_key>
#   SUPABASE_BUCKET=tiles  (optional, defaults to 'tiles')
UPLOAD_TO_SUPABASE = True
SUPABASE_BUCKET = os.environ.get("SUPABASE_BUCKET", "tiles")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

def upload_tile_to_supabase(storage_path, png_bytes):
    """Upload a tile PNG directly via Supabase Storage REST API."""
    url = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{storage_path}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "apikey": SUPABASE_SERVICE_KEY,
        "Content-Type": "image/png",
        "x-upsert": "true",
    }
    resp = requests.post(url, headers=headers, data=png_bytes, timeout=30)
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text}")

# Day range and interval
DAY_START = 53
DAY_END = 180
DAY_INTERVAL = 1

# Grid cell size in miles (matching CPU mode precisely)
CELL_SIZE_MILES = 2

# Batch size for parallel tile processing
BATCH_SIZE = 32

# Debug labels on tiles
ENABLE_DEBUG_LABELS = False

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
    """Convert Web Mercator (EPSG:3857) coordinates to WGS84 lat/lon on GPU."""
    lon = (x / 20037508.34) * 180.0
    lat = (y / 20037508.34) * 180.0
    lat = 180.0 / cp.pi * (2.0 * cp.arctan(cp.exp(lat * cp.pi / 180.0)) - cp.pi / 2.0)
    return lon, lat


def geographic_to_pixel_gpu(lon, lat, transform, width, height):
    """Convert geographic coordinates to source raster pixel coordinates on GPU."""
    a, b, c, d, e, f = transform.a, transform.b, transform.c, transform.d, transform.e, transform.f
    col = (lon - c) / a
    row = (lat - f) / e
    return col, row


def classify_foliage_gpu(spring_days, current_day):
    """GPU-accelerated foliage classification."""
    days_diff = current_day - spring_days
    rgba = cp.zeros((*spring_days.shape, 4), dtype=cp.uint8)
    
    invalid = (spring_days < 1) | (spring_days > 365)
    none_mask = (days_diff < -15) & ~invalid
    budding_mask = (days_diff >= -15) & (days_diff < -10)
    firstLeaf_mask = (days_diff >= -10) & (days_diff < -5)
    firstBloom_mask = (days_diff >= -5) & (days_diff < 3)
    peakBloom_mask = (days_diff >= 3) & (days_diff < 10)
    canopy_mask = (days_diff >= 10) & (days_diff < 20)
    postBloom_mask = (days_diff >= 20) & ~invalid
    
    rgba[none_mask] = (*FOLIAGE_COLORS["none"], 255)
    rgba[budding_mask] = (*FOLIAGE_COLORS["budding"], 255)
    rgba[firstLeaf_mask] = (*FOLIAGE_COLORS["firstLeaf"], 255)
    rgba[firstBloom_mask] = (*FOLIAGE_COLORS["firstBloom"], 255)
    rgba[peakBloom_mask] = (*FOLIAGE_COLORS["peakBloom"], 255)
    rgba[canopy_mask] = (*FOLIAGE_COLORS["canopy"], 255)
    rgba[postBloom_mask] = (*FOLIAGE_COLORS["postBloom"], 255)
    rgba[invalid] = (0, 0, 0, 0)
    
    return rgba


def miles_to_degrees_lat(miles):
    """Convert miles to degrees latitude (approximately)."""
    return miles / 69.0  # 1 degree latitude ≈ 69 miles


def miles_to_degrees_lon(miles, latitude):
    """Convert miles to degrees longitude at given latitude."""
    return miles / (69.0 * math.cos(math.radians(latitude)))


def render_tile_gpu_quantized(source_data_gpu, transform, src_width, src_height, tile, current_day):
    """
    Render a single tile using GPU acceleration with quantized 'grid' sampling.
    Achieves the boxy grid look without slow CPU loops.
    """
    bounds = mercantile.bounds(tile)
    west, south, east, north = bounds.west, bounds.south, bounds.east, bounds.north
    
    # Convert to Web Mercator meters
    west_m = west * 20037508.34 / 180.0
    east_m = east * 20037508.34 / 180.0
    
    # Correct Web Mercator latitude calculation
    def lat_to_y(lat):
        return math.log(math.tan((90 + lat) * math.pi / 360.0)) / (math.pi / 180.0) * 20037508.34 / 180.0
    
    south_m = lat_to_y(south)
    north_m = lat_to_y(north)
    
    # Pixel grid
    x_coords = cp.linspace(west_m, east_m, TILE_SIZE, dtype=cp.float32)
    y_coords = cp.linspace(north_m, south_m, TILE_SIZE, dtype=cp.float32)
    x_grid, y_grid = cp.meshgrid(x_coords, y_coords)
    
    # 1. Convert pixels to Geographic
    lon_grid, lat_grid = web_mercator_to_geographic(x_grid, y_grid)
    
    # 2. QUANTIZE Coordinates to Grid Cells (the magic part)
    # We want to "snap" the lon/lat to the center of a grid cell.
    # 1 degree lat ≈ 69 miles. 1 degree lon ≈ 69 * cos(lat) miles.
    lat_deg_per_mile = 1.0 / 69.0
    lon_deg_per_mile = 1.0 / (69.0 * math.cos(math.radians((south + north) / 2)))
    
    lat_step = CELL_SIZE_MILES * lat_deg_per_mile
    lon_step = CELL_SIZE_MILES * lon_deg_per_mile
    
    # Snap to grid: floor(coord / step) * step + half_step
    # Quantizing lon_grid and lat_grid creates the "boxy" cells
    q_lon = cp.floor(lon_grid / lon_step) * lon_step + (lon_step / 2.0)
    q_lat = cp.floor(lat_grid / lat_step) * lat_step + (lat_step / 2.0)
    
    # 3. Sample from source matching CPU logic
    col_grid, row_grid = geographic_to_pixel_gpu(q_lon, q_lat, transform, src_width, src_height)
    
    # Nearest neighbor sampling of the GeoTIFF (order=0)
    # This prevents blurring at the edges of the boxes
    coords = cp.stack([row_grid, col_grid])
    sampled = map_coordinates(source_data_gpu, coords, order=0, mode='constant', cval=0)
    
    # Check data
    if not cp.any((sampled >= 1) & (sampled <= 365)):
        return None
        
    rgba = classify_foliage_gpu(sampled, current_day)
    return cp.asnumpy(rgba)


def save_tile(tile_data, tile, day_dir):
    """Save a tile to disk (and optionally upload to Supabase)."""
    from PIL import ImageDraw, ImageFont
    zoom_dir = day_dir / str(tile.z)
    tile_dir = zoom_dir / str(tile.x)
    tile_dir.mkdir(parents=True, exist_ok=True)
    
    tile_path = tile_dir / f"{tile.y}.png"
    img = Image.fromarray(tile_data, mode='RGBA')
    
    if ENABLE_DEBUG_LABELS:
        draw = ImageDraw.Draw(img)
        text = f"z={tile.z} x={tile.x} y={tile.y}"
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 16)
        except:
            font = ImageFont.load_default()
        
        bbox = draw.textbbox((0, 0), text, font=font)
        draw.rectangle([3, 3, 3 + (bbox[2]-bbox[0]) + 4, 3 + (bbox[3]-bbox[1]) + 4], fill=(255, 255, 255, 200))
        draw.text((5, 5), text, fill=(0, 0, 0, 255), font=font)
    
    # Write to bytes buffer (used for both disk and Supabase)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=False)
    png_bytes = buf.getvalue()

    # Save to disk
    tile_path.write_bytes(png_bytes)

    # Upload to Supabase if enabled
    if UPLOAD_TO_SUPABASE:
        storage_path = f"{day_dir.name}/{tile.z}/{tile.x}/{tile.y}.png"
        try:
            upload_tile_to_supabase(storage_path, png_bytes)
        except Exception as e:
            print(f"❌ Supabase upload failed for {storage_path}: {e}")


def generate_tiles_for_day_gpu(source_data_gpu, transform, src_width, src_height, day, output_base_dir):
    """Generate tiles using GPU acceleration with quantization."""
    day_dir = Path(output_base_dir) / f"day_{day:03d}"
    print(f"\n📅 Day {day} (GPU Quantized Grid)")
    
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = []
        for zoom in range(MIN_ZOOM, MAX_ZOOM + 1):
            tiles = list(mercantile.tiles(-125, 24, -66, 50, zoom))
            print(f"  Zoom {zoom}: {len(tiles)} tiles")
            
            for i in tqdm(range(0, len(tiles), BATCH_SIZE), desc=f"    z{zoom}", leave=False):
                batch = tiles[i:i+BATCH_SIZE]
                for tile in batch:
                    tile_data = render_tile_gpu_quantized(source_data_gpu, transform, src_width, src_height, tile, day)
                    if tile_data is not None:
                        futures.append(executor.submit(save_tile, tile_data, tile, day_dir))
        
        for future in futures:
            future.result()


def main():
    """Main GPU tile generation pipeline."""
    print("🌸 GPU-Accelerated Gridded Tile Generator")
    print("=" * 50)

    if UPLOAD_TO_SUPABASE:
        # Validate credentials early before spending time on generation
        if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")
        print(f"☁️  Supabase upload enabled → bucket: '{SUPABASE_BUCKET}'")
        print(f"    URL: {SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/")
    else:
        print("💾 Saving tiles to disk only (UPLOAD_TO_SUPABASE=False)")
    
    geotiff_path = Path(GEOTIFF_PATH)
    if not geotiff_path.exists():
        print(f"❌ Error: GeoTIFF not found at {geotiff_path}")
        return
        
    with rasterio.open(geotiff_path) as src:
        source_data_cpu = src.read(1)
        transform = src.transform
        src_width = src.width
        src_height = src.height
        
    source_data_gpu = cp.array(source_data_cpu, dtype=cp.float32)
    print(f"✅ Data loaded to GPU ({source_data_gpu.nbytes / 1e6:.1f} MB)")
    
    days = range(DAY_START, DAY_END + 1, DAY_INTERVAL)
    for day in days:
        generate_tiles_for_day_gpu(source_data_gpu, transform, src_width, src_height, day, OUTPUT_DIR)
    
    print("\n✅ Generation complete!")


if __name__ == "__main__":
    main()
