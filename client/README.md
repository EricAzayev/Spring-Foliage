# Spring Foliage Map - Client

An interactive React + Vite frontend for visualizing spring foliage phenology across the United States.

## Rendering Modes

The map supports multiple rendering modes for generating foliage tiles:

### ⚡ GPU Mode (Default - Recommended)
- **Status**: Active and optimized
- **How it works**: Uses WebGL to process grid points in parallel on the user's GPU
- **Performance**: 50-200× faster than CPU mode
- **Best for**: Real-time interactivity and responsive slider updates

**Starting the development server defaults to GPU Mode:**
```bash
npm run dev
```

### 🔧 CPU Mode
- **Status**: Available as fallback
- **How it works**: Sequential point sampling on the CPU
- **Performance**: Baseline (slower for large grids)
- **Best for**: Testing and CPU-constrained environments

**Toggle to CPU Mode**: Click the mode button in the top-right corner of the map.

### 📁 Raster Mode (Temporarily Disabled)
- **Status**: Disabled for development focus
- **How it works**: Pre-generated tile images served from `public/tiles/`
- **Why disabled**: Currently focused on optimizing GPU-based generation

**To re-enable Raster Mode:**

1. Edit `client/src/components/Map.jsx`
2. Change the default map mode in the Map component:
   ```javascript
   const [mapMode, setMapMode] = useState("raster"); // Change from "gpu"
   ```
3. Update the `toggleMapMode` function to include raster in the cycle:
   ```javascript
   const toggleMapMode = () => {
     setMapMode(prev => {
       if (prev === "cpu") return "gpu";
       if (prev === "gpu") return "raster";
       return "cpu";
     });
   };
   ```
4. Update the mode button UI to show raster:
   ```javascript
   {mapMode === "raster" && "📁 Raster Mode"}
   ```
5. Ensure pre-generated tiles exist in `public/tiles/day_XXX/{z}/{x}/{y}.png`
   - Run `python generate_tiles.py` in the `data_generator/` directory
   - Or use GPU-accelerated generation: `python generate_tiles_gpu.py`

## Development Setup

### Install Dependencies
```bash
npm install
```

### Start Development Server (GPU Mode)
```bash
npm run dev
```
Opens at `http://localhost:5173` with GPU Mode enabled.

### Build for Production
```bash
npm run build
```
Generates optimized static files in `dist/`.

### Preview Production Build
```bash
npm run preview
```

## Project Structure

```
client/
├── src/
│   ├── components/
│   │   ├── Map.jsx           # Main map component with 3 rendering modes
│   │   └── Map.css
│   ├── utils/
│   │   ├── gpuProcessor.js   # WebGL GPU processing engine
│   │   └── terrainConfig.js  # Terrain layer configuration
│   ├── App.jsx               # Root component
│   ├── App.css
│   ├── main.jsx              # Entry point
│   └── index.css
├── public/
│   ├── SpringBloom_30yr.tif  # Source GeoTIFF raster data
│   ├── us-states.json        # State boundary data
│   └── tiles/                # Pre-generated tiles (optional for Raster Mode)
├── vite.config.js
└── package.json
```

## Key Technologies

- **React 18** — UI framework with hooks
- **Vite** — Lightning-fast build tool
- **MapLibre GL** — Interactive map library
- **WebGL** — GPU-accelerated tile processing
- **GeoTIFF** — Raster data format for bloom day values
- **Turf.js** — Geospatial analysis library

## Performance Tips

- **GPU Mode** is fastest for interactive use (50-200× speedup)
- **CPU Mode** is useful for debugging or environments without GPU support
- **Raster Mode** would be cached static tiles (when re-enabled)

## Troubleshooting

**GPU Mode not working?**
- Check browser WebGL support: Navigate to `https://get.webgl.org/`
- If WebGL unavailable, the map will auto-fallback to CPU Mode

**Map loading slowly?**
- Ensure `SpringBloom_30yr.tif` is present in `public/`
- Check network tab in DevTools for failed GeoTIFF load

**Tiles missing (for Raster Mode)?**
- Run tile generation script in `data_generator/` directory
- Verify `public/tiles/` contains the generated day folders

