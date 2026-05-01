// Terrain Source Configuration: OpenTopoMap (free, no API key needed)
export const getTerrainSource = () => ({
  type: "raster-dem",
  url: "https://tile.opentopomap.org/data/raster/GEBCO_LATEST/GEBCO_LATEST.json",
  tileSize: 256,
  maxzoom: 13,
});

export const TERRAIN_CONFIG = getTerrainSource();
