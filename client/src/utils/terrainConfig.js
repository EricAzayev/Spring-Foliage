/**
 * Terrain Source Configuration
 * 
 * Multiple options for 3D terrain data:
 * 1. OpenTopoMap (free, no key required)
 * 2. Mapbox (requires key)
 * 3. USGS (free, limited coverage)
 * 4. Local cached tiles (requires tile generation)
 */

export const getTerrainSource = () => {
  // Option 1: OpenTopoMap (Free, no API key needed)
  // Provides global terrain coverage
  return {
    type: "raster-dem",
    url: "https://tile.opentopomap.org/data/raster/GEBCO_LATEST/GEBCO_LATEST.json",
    tileSize: 256,
    maxzoom: 13,
  };

  // Option 2: If you still want MapTiler (requires API key)
  // return {
  //   type: "raster-dem",
  //   url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
  //   tileSize: 256,
  //   maxzoom: 14,
  // };

  // Option 3: USGS elevation tiles (US-only, free)
  // return {
  //   type: "raster-dem",
  //   url: "https://elevation-tiles-prod.s3.amazonaws.com/geotiffs/USGS_13_N{z}_{x}_{y}.tif",
  //   tileSize: 256,
  //   maxzoom: 13,
  // };

  // Option 4: Local cached tiles (advanced - requires tile generation)
  // Generate tiles locally with gdal2tiles.py or similar
  // return {
  //   type: "raster-dem",
  //   url: "data:application/json;base64,...", // or serve from /public/tiles/terrain/{z}/{x}/{y}.tif
  //   tileSize: 256,
  //   maxzoom: 11,
  // };
};

export const TERRAIN_CONFIG = getTerrainSource();
