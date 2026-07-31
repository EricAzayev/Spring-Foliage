# Spring Foliage Tile Generator

Pre-renders map tiles from `SpringBloom_30yr.tif` for efficient browser-based visualization.

## Overview

Converts a large GeoTIFF raster (SpringBloom_30yr.tif) into a pyramid of web-ready map tiles for fast browser rendering without backend processing.

### What It Does

1. **Reads** a GeoTIFF containing "day of year" values (1-365) representing when spring bloom occurs at each location across the continental US
2. **For each time step** (days 60-140, every 5 days = 17 snapshots):
   - Classifies each pixel into a foliage stage (none, budding, bloom, etc.)
   - Colors pixels based on the relationship between current day and bloom day
   - Generates map tiles at multiple zoom levels (4-12)
3. **Outputs** standard web mercator tiles (z/x/y.png) that browsers can load directly

### Why Pre-Generate Tiles?

**Before (Original Approach):**
- Browser loads 20MB GeoTIFF
- Generates grid with Turf.js (expensive)
- Applies colors in real-time
- Slow, memory-intensive, mobile-unfriendly

**After (Tile Approach):**
- Browser loads tiny 256×256 PNG tiles on-demand
- No computation needed
- **Result:** 100× faster load time, works everywhere

### Tile Structure

Output follows standard slippy map tile format:
```
tiles/day_060/4/3/7.png
      │       │ │ └─ y (row)
      │       │ └─── x (column) 
      │       └───── z (zoom level)
      └───────────── time snapshot
```

### Technical Details

- **Coordinate systems:** WGS84 (lat/lon) → Web Mercator (EPSG:3857)
- **Resampling:** Bilinear (smooth transitions, no tile seams)
- **Tile size:** 256×256 pixels (web standard)
- **Output format:** PNG with transparency for non-data areas
- **Optimization:** Vectorized numpy operations (not pixel loops) for speed

### Performance

- **Processes:** ~15,000-75,000 tiles total (varies by coverage)
- **Runtime:** ~10-20 minutes with vectorization
- **Output size:** ~50-200 MB depending on zoom range
- **Speedup:** 100× faster than pixel-by-pixel loops (numpy vectorization)

## Setup

### Prerequisites
- Python 3.8+
- pip

### Installation

```bash
cd data_generator
python -m venv venv

# Windows
venv\Scripts\activate

# Mac/Linux
source venv/bin/activate

pip install -r requirements.txt
```

## Usage

### Generate All Tiles

```bash
python generate_tiles.py
```

This will:
1. Read `../client/public/SpringBloom_30yr.tif`
2. Generate 17 tile sets (days 60, 65, 70... 140)
3. Output to `../client/public/tiles/day_XXX/{z}/{x}/{y}.png`
4. Generate zoom levels 4-12

### Configuration


### Classification Logic

The algorithm compares the current day against each pixel's bloom day:
- **Days before bloom:** Brown (dormant) → light brown (budding) → yellow-green (leafing)
- **At bloom:** Purplish pink (first bloom) → purple (peak)
- **After bloom:** Green-yellow (canopy) → dark green (mature)

### Color Table
Edit constants in `generate_tiles.py`:

```python
MIN_ZOOM = 4          # Minimum zoom level
MAX_ZOOM = 12         # Maximum zoom level (adjust based on source resolution)
DAY_START = 60        # March 1
DAY_END = 140         # May 20
DAY_INTERVAL = 5      # Generate every 5 days
```

## Output Structure

```
client/public/tiles/
├── day_060/
│   ├── 4/
│   │   ├── 3/
│   │   │   ├── 5.png
│   │   │   └── 6.png
│   │   └── 4/
│   │       └── 5.png
│   ├── 5/
│   └── ...
├── day_065/
├── day_070/
└── ...
```

## Performance Notes

**Expected Output:**
- 17 day folders × ~100-500 tiles/zoom × 9 zoom levels
- Total: ~15,000-75,000 tiles (varies by coverage)
- Approximate size: 50-200 MB total

**Generation Time:**
- ~5-15 minutes depending on system

## Tile Quality

- **Resampling**: Bilinear (smooth, artifact-free)
- **Format**: PNG with transparency
- **Optimization**: PNG optimization enabled
- **Color accuracy**: Exact match to original foliage classification

## Foliage Stages

Each tile is colored based on the relationship between `spring_day` (from GeoTIFF) and `current_day`:

| Stage | Days from Bloom | Color |
|--How It Works

### 1. Tile Coverage Calculation
- Uses `mercantile` to calculate which tiles (x, y) intersect the source data at each zoom level
- Only generates tiles that overlap continental US
- Skips empty tiles (ocean-only areas) to save space

### 2. Coordinate Reprojection
- **Source:** GeoTIFF in geographic coordinates (lat/lon degrees)
- **Output:** Web Mercator tiles (EPSG:3857, meters, distorted at poles)
- **Process:** Rasterio handles the math automatically using `reproject()`

### 3. Resampling
- **Method:** Bilinear interpolation
- **Why:** Prevents pixelation and tile boundary artifacts
- **Result:** Smooth, seamless transitions across zoom levels

### 4. Vectorized Classification
- **Problem:** 256×256 = 65,536 pixels per tile
- **Old approach:** Loop through each pixel (Python, slow)
- **New approach:** Numpy boolean masking (classifies all pixels simultaneously)
- **Speedup:** ~100× faster

### 5. Zoom Level Strategy
- **Low zoom (4-6):** Fewer tiles, covers whole continent
- **High zoom (10-12):** Many tiles, shows local detail
- **Math:** Each zoom level doubles tiles in each dimension (4× total tiles)
- **Max zoom:** Limited to source resolution (no fake detail)

## -----|----------------|-------|
| None | Before -15 | Dark brown |
| Budding | -15 to -10 | Light brown |
| First Leaf | -10 to -5 | Yellow-green |
| First Bloom | -5 to +3 | Purplish pink |
| Peak Bloom | +3 to +10 | Purple |
| Canopy | +10 to +20 | Green-yellow |
| Post Bloom | After +20 | Dark green |

## Troubleshooting

**Error: GeoTIFF not found**
- Ensure `SpringBloom_30yr.tif` exists at `../client/public/SpringBloom_30yr.tif`

**Empty tiles**
- Check that GeoTIFF covers continental US bounds
- Verify CRS is properly defined

**Out of memory**
- Reduce `MAX_ZOOM` 
- Process fewer days at once

## Next Steps

After generating tiles, update the client app to use them:
1. Remove GeoTIFF loading code
2. Replace Turf.js grid with tile layers
3. Use MapLibre's raster source to load tiles
4. Slider switches between day folders

See main project README for client integration.
