# GPU Tile Generator - Quick Start

## Prerequisites

1. **NVIDIA GPU** with CUDA support (tested on RTX 3080)
2. **CUDA Toolkit** installed (version 12.x recommended)
3. **Python 3.8+**

## Installation

```bash
cd data_generator

# Create virtual environment
python -m venv venv

# Activate (Linux/Mac)
source venv/bin/activate

# Activate (Windows)
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

> [!IMPORTANT]
> If `cupy-cuda12x` installation fails, you may need to install a version matching your CUDA toolkit:
> - CUDA 11.x: `pip install cupy-cuda11x`
> - CUDA 12.x: `pip install cupy-cuda12x`
> - Check your CUDA version with: `nvcc --version`

## Usage

```bash
python generate_tiles_gpu.py
```

This will:
- Load `SpringBloom_30yr.tif` into GPU memory (~20-50 MB VRAM)
- Generate tiles for days 60-140 (every 5 days = 17 snapshots)
- Output to `../client/public/tiles/day_XXX/{z}/{x}/{y}.png`
- Process zoom levels 4-12

## Performance

**Expected speedup**: 100-1000× faster than CPU version

**Example timings** (RTX 3080):
- CPU version: 10-20 minutes per day → **3-6 hours total**
- GPU version: 5-30 seconds per day → **2-10 minutes total**

## Configuration

Edit constants in `generate_tiles_gpu.py`:

```python
MIN_ZOOM = 4          # Minimum zoom level
MAX_ZOOM = 12         # Maximum zoom level
DAY_START = 60        # March 1
DAY_END = 140         # May 20
DAY_INTERVAL = 5      # Generate every 5 days
BATCH_SIZE = 32       # Tiles processed in parallel
```

## Troubleshooting

**CUDA not found**:
```bash
# Verify CUDA installation
nvidia-smi
nvcc --version
```

**Out of VRAM**:
- Reduce `MAX_ZOOM` (each level = 4× more tiles)
- Reduce `BATCH_SIZE` (default: 32)

**CuPy import error**:
- Ensure CUDA toolkit version matches CuPy package
- Try: `pip install cupy` (auto-detects CUDA version)

## Comparison with CPU Version

| Feature | CPU (`generate_tiles.py`) | GPU (`generate_tiles_gpu.py`) |
|---------|---------------------------|-------------------------------|
| **Speed** | 10-20 min/day | 5-30 sec/day |
| **Memory** | ~500 MB RAM | ~500 MB VRAM |
| **Dependencies** | rasterio, numpy | + cupy, CUDA toolkit |
| **Hardware** | Any CPU | NVIDIA GPU required |

## Next Steps

After generating tiles, the client app can load them directly:
1. Remove GeoTIFF loading code from client
2. Use MapLibre's raster source to load tiles
3. Slider switches between `day_XXX` folders

See main project README for client integration.


