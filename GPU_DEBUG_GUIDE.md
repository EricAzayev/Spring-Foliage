# GPU Tile Renderer - Critical Bugs & Fixes

## Executive Summary
Your 256x256 tiles are rendering as solid colors (all visible) because of **coordinate transformation bugs** in the shader + potential Y-axis double-flip. The 65,536 visible pixels (100% opacity) is actually diagnostic: it means the shader IS rendering successfully, but is sampling the WRONG part of the GeoTIFF texture—or worse, sampling garbage memory.

---

## Bug #1: Y-Axis Coordinate Transformation ❌ CRITICAL

### The Problem
In `rasterTileProcessor.js` fragment shader (line ~85):
```glsl
float yRatio = (bbox.w - lat) / (bbox.w - bbox.y);
```

This is **inverted**. Here's why:

#### Coordinate Space Chain:
1. **Tile fragment space** (WebGL render output): (0,0) at bottom-left, (255,255) at top-right
2. **Geographic space** (lat/lon): lat increases northward  
3. **Raster pixel space** (GeoTIFF in-memory): array index increases downward (row 0 = top of image)
4. **WebGL texture space** (after upload): (0,0.5) at center-bottom (OpenGL convention)

#### The Mapping Chain That Matters:
Your shader does:
- Tile fragment → Geographic → Raster texture coordinate

**The bug:** When converting from geographic to texture coordinates, you have:
```
lat = north → should sample TOP of raster → texture v should be HIGH (close to 1)
lat = south → should sample BOTTOM of raster → texture v should be LOW (close to 0)
```

But your formula gives:
```
lat = north (bbox.w):  yRatio = 0  ← This is WRONG (should be ~1)
lat = south (bbox.y):  yRatio = 1  ← This is WRONG (should be ~0)
```

### The Fix
Change line 85 in `rasterTileProcessor.js` from:
```glsl
float yRatio = (bbox.w - lat) / (bbox.w - bbox.y);
```

To:
```glsl
float yRatio = (lat - bbox.y) / (bbox.w - bbox.y);
```

**Why this works:**
- `lat = south` → numerator = 0 → v = 0 → samples bottom of texture ✓
- `lat = north` → numerator = (north-south) → v = 1 → samples top of texture ✓
- Correctly maps the bloom day data to tile coordinates

---

## Bug #2: Possible Y-Axis Double-Flip ⚠️ HIGH

### The Problem
After fixing Bug #1, you might get upside-down output due to **conflicting Y-axis flips**.

In `generateTile()` (line ~333):
```javascript
const canvasIdx = ((TILE_SIZE - 1 - py) * TILE_SIZE + px) * 4;
```

**Decision tree:**
- If Bug #1 fix puts tiles right-side-up → KEEP this flip (correct usage)
- If Bug #1 fix puts tiles upside-down → REMOVE this flip

### How to Know
After applying Bug #1 fix:
- ✅ Tiles appear upside-down? → Remove the flip
- ✅ Tiles appear right-side-up? → Keep the flip
- ✅ Tiles look weird/garbled? → Proceed to Bug #3

---

## Bug #3: Bounding Box Format Ambiguity 🔴 CRITICAL

### The Problem
Your bbox detection in `Map.jsx` `loadGeoTIFF()` (line ~475) is questionable:

```javascript
const isNorthFirst = bb[1] > bb[3];  // <- This condition rarely/never triggers
const bbox = isNorthFirst
  ? [bb[0], bb[3], bb[2], bb[1]]  // [west, south, east, north]
  : [bb[0], bb[1], bb[2], bb[3]]; // assume wrong format
```

**The issue:** GeoTIFF.js `getBoundingBox()` returns `[minX, minY, maxX, maxY]` in the image's coordinate reference system. For WGS84 (lat/lon):
- `minX` = westernmost longitude (often -130 for USA)
- `minY` = southernmost latitude (often ~25)
- `maxX` = easternmost longitude (often -65)  
- `maxY` = northernmost latitude (often ~48)

So: `bb[1] < bb[3]` **always** (minY < maxY). Your condition is backwards!

### The Fix
In `Map.jsx` around line 475, **replace the entire bbox detection**:

```javascript
// GeoTIFF.js returns [minX, minY, maxX, maxY] in geographic coords
// For WGS84, minY is south and maxY is north
const bbox = [bb[0], bb[1], bb[2], bb[3]];  // [west, south, east, north]
```

**Verify your assumptions** by adding direct logging:
```javascript
console.log(`GeoTIFF bounds: W=${bb[0].toFixed(1)}, S=${bb[1].toFixed(1)}, E=${bb[2].toFixed(1)}, N=${bb[3].toFixed(1)}`);
```
- Should print something like: `W=-130.0, S=25.0, E=-65.0, N=48.0`
- If E < W or N < S, then the data is in a non-standard format

---

## Bug #4: Texture Upload—RGBA Conversion 🔴 HIGH PRIORITY

### The Problem
You're converting single-channel normalized bloom day to RGBA by replicating across RGB:
```javascript
rgbaData[i * 4] = val;     // R
rgbaData[i * 4 + 1] = val; // G  
rgbaData[i * 4 + 2] = val; // B
rgbaData[i * 4 + 3] = 255; // A = opaque
```

**Why this is suspicious:** If this is working, then all pixels should appear GRAY in the tile, not a rainbow. If they're appearing as solid color (not gray), the texture might not be uploading or your shader might have an issue.

### Diagnostic: Render Texture Directly
Add a debug shader that shows the raw texture (without bloom day mapping):

```glsl
gl_FragColor = vec4(texture2D(rasterTexture, rasterCoord).rgb, 1.0);
```

If tiles are:
- ✅ **All gray/white**: Texture uploaded correctly, bug is in coordinate mapping or bloom day formula
- ❌ **All black or garbled**: Texture upload failed, or coordinates are out of bounds (sampling black border)

---

## Master Checklist: Fixes to Apply

### Immediate (5 min):
- [ ] Fix Bug #1: Shader Y-ratio formula (line 85 of rasterTileProcessor.js)
- [ ] Fix Bug #3: Bbox detection (lines ~475 in Map.jsx)
- [ ] Add console logging to verify bbox values are [W,S,E,N]

### Next (10 min):
- [ ] Test render → observe tile orientation
- [ ] Apply Bug #2 fix if needed (remove Y-flip)
- [ ] Add debug shader to render raw texture (no bloom day mapping)

### Debug (15 min):
- [ ] Check console for WebGL errors  
- [ ] Verify GeoTIFF pixel range is actually 54-180 (log min/max)
- [ ] Verify normalized data doesn't have all-zero or all-max problems

---

## Additional Validation Tests

### Test 1: Rainbow Gradient Instead of Real Data
Temporarily replace shader bloom day sampling with a gradient:
```glsl
float bloomDayNormalized = xRatio; // Use X coordinate as test
gl_FragColor = vec4(xRatio, 1.0 - xRatio, 0.5 * yRatio, 1.0);
```
Should produce a gradient tile (red-left to cyan-right). If tiles are solid color, render pipeline is broken.

### Test 2: Verify Tile Bounds
Log the four corners of rendered tile:
```javascript
const corners = [
  [bbox.west, bbox.north],  // NW
  [bbox.east, bbox.north],  // NE
  [bbox.east, bbox.south],  // SE
  [bbox.west, bbox.south]   // SW
];
console.log("Tile corners:", corners);
```
Should form a valid rectangle on the map in the expected position.

### Test 3: Monitor Pixel Opacity
Your diagnostic already does this:
```javascript
/>"[GPU] Pixel stats: ${pixelCount} visible, ${transparentCount} transparent"
```
- If **all 65,536 pixels visible**: Shader always returns `gl_FragColor.a = 1.0` → check bloom day sampling
- If **0-1000 pixels visible**: Check if shader is outputting no-data color correctly
- If **varied count by tile**: Shader is working, data mapping issue

---

## Expected Result After Fixes
✅ Tiles render correctly positioned on map  
✅ Colors match CPU mode (when dayOfYear is synchronized)  
✅ Zoom in/out updates tiles smoothly  
✅ WebGL console has **zero errors** (only warnings are OK)
