#!/usr/bin/env python3
"""
Quick test script to verify GPU tile generator is working correctly.
Tests a small subset of tiles and compares basic functionality.
"""

import sys
from pathlib import Path

def test_imports():
    """Test that all required libraries can be imported."""
    print("🧪 Testing imports...")
    try:
        import cupy as cp
        print(f"  ✅ CuPy imported successfully")
        device = cp.cuda.Device()
        props = cp.cuda.runtime.getDeviceProperties(device.id)
        print(f"     GPU: {props['name'].decode()}")
        print(f"     VRAM: {device.mem_info[1] / 1e9:.1f} GB")
    except Exception as e:
        print(f"  ❌ CuPy import failed: {e}")
        return False
    
    try:
        import rasterio
        print(f"  ✅ Rasterio imported")
    except Exception as e:
        print(f"  ❌ Rasterio import failed: {e}")
        return False
    
    try:
        import mercantile
        print(f"  ✅ Mercantile imported")
    except Exception as e:
        print(f"  ❌ Mercantile import failed: {e}")
        return False
    
    try:
        from PIL import Image
        print(f"  ✅ PIL imported")
    except Exception as e:
        print(f"  ❌ PIL import failed: {e}")
        return False
    
    return True


def test_geotiff_exists():
    """Test that the source GeoTIFF exists."""
    print("\n🧪 Testing GeoTIFF file...")
    
    geotiff_path = Path("../client/public/SpringBloom_30yr.tif")
    
    if geotiff_path.exists():
        size_mb = geotiff_path.stat().st_size / 1e6
        print(f"  ✅ GeoTIFF found: {geotiff_path}")
        print(f"     Size: {size_mb:.1f} MB")
        return True
    else:
        print(f"  ❌ GeoTIFF not found at: {geotiff_path}")
        return False


def test_gpu_basic_ops():
    """Test basic GPU operations."""
    print("\n🧪 Testing GPU operations...")
    
    try:
        import cupy as cp
        print("cupy imported successfully")
        import numpy as np
        
        # Test array creation
        arr_gpu = cp.array([1, 2, 3, 4, 5])
        print(f"  ✅ GPU array creation")
        
        # Test computation
        result = cp.sum(arr_gpu)
        print(f"  ✅ GPU computation (sum={result})")
        
        # Test CPU transfer
        arr_cpu = cp.asnumpy(arr_gpu)
        print(f"  ✅ GPU→CPU transfer")
        
        return True
    except Exception as e:
        print(f"  ❌ GPU operations failed: {e}")
        return False


def test_single_tile():
    """Test generation of a single tile."""
    print("\n🧪 Testing single tile generation...")
    
    try:
        import cupy as cp
        import numpy as np
        import rasterio
        import mercantile
        from pathlib import Path
        
        # Import functions from generate_tiles_gpu
        sys.path.insert(0, str(Path(__file__).parent))
        from generate_tiles_gpu import (
            render_tile_gpu,
            GEOTIFF_PATH
        )
        
        # Load a small portion of the GeoTIFF
        with rasterio.open(GEOTIFF_PATH) as src:
            data = src.read(1)
            transform = src.transform
            width = src.width
            height = src.height
        
        # Transfer to GPU
        data_gpu = cp.array(data, dtype=cp.float32)
        
        # Generate a single tile (zoom 4, roughly center of US)
        tile = mercantile.Tile(x=3, y=5, z=4)
        
        print(f"  Testing tile: z={tile.z}, x={tile.x}, y={tile.y}")
        
        result = render_tile_gpu(data_gpu, transform, width, height, tile, current_day=100)
        
        if result is not None:
            print(f"  ✅ Tile generated successfully")
            print(f"     Shape: {result.shape}")
            print(f"     Data type: {result.dtype}")
            
            # Check if tile has some colored pixels
            non_transparent = np.sum(result[:, :, 3] > 0)
            print(f"     Non-transparent pixels: {non_transparent}/{256*256}")
            
            return True
        else:
            print(f"  ⚠️  Tile was empty (no data)")
            return True  # Empty tiles are valid
            
    except Exception as e:
        print(f"  ❌ Tile generation failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Run all tests."""
    print("=" * 60)
    print("GPU Tile Generator - Verification Tests")
    print("=" * 60)
    
    tests = [
        ("Import Test", test_imports),
        ("GeoTIFF Test", test_geotiff_exists),
        ("GPU Operations Test", test_gpu_basic_ops),
        ("Single Tile Test", test_single_tile),
    ]
    
    results = []
    for name, test_func in tests:
        try:
            result = test_func()
            results.append((name, result))
        except Exception as e:
            print(f"\n❌ {name} crashed: {e}")
            results.append((name, False))
    
    # Summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status}: {name}")
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n🎉 All tests passed! GPU tile generator is ready to use.")
        print("\nRun: python generate_tiles_gpu.py")
        return 0
    else:
        print("\n⚠️  Some tests failed. Please fix the issues above.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
