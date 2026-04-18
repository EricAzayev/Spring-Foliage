import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import * as GeoTIFF from "geotiff";
import RasterTileProcessor from "../utils/rasterTileProcessor.js";
import "./Map.css";

// Helper functions for tile coordinate conversion (Web Mercator)
const lngLatToTile = (lng, lat, zoom) => {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  return { x, y, z: zoom };
};

const tileBounds = (tile) => {
  const n = Math.pow(2, tile.z);
  const west = (tile.x / n) * 360 - 180;
  const east = ((tile.x + 1) / n) * 360 - 180;
  const south = Math.atan(Math.sinh(-Math.PI * (2 * (tile.y + 1) / n - 1))) * 180 / Math.PI;
  const north = Math.atan(Math.sinh(-Math.PI * (2 * tile.y / n - 1))) * 180 / Math.PI;
  return { west, east, south, north };
};

const Map = ({ dayOfYear }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [is3DView, setIs3DView] = useState(false);
  const [mapMode, setMapMode] = useState("gpu");
  const [geoTiffLoaded, setGeoTiffLoaded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const gridCache = useRef(null);
  const gpuProcessor = useRef(null);
  const statesGeoJSON = useRef(null);
  const geoTiffData = useRef(null);
  const activeTiles = useRef(new Set()); // Track rendered tiles
  const dayOfYearRef = useRef(dayOfYear);
  useEffect(() => { dayOfYearRef.current = dayOfYear; }, [dayOfYear]);

  const foliageColors = {
    none: "#4B3621",
    budding: "#A67B5B",
    firstLeaf: "#C9D96F",
    firstBloom: "#DA70D6",
    peakBloom: "#800080",
    canopy: "#ADFF2F",
    postBloom: "#006400",
  };

  // Helper function to render GPU tiles for current viewport
  const updateGPUTiles = async (processor, dayOfYear) => {
    if (!processor || !map.current || mapMode !== "gpu") return;

    try {
      setIsProcessing(true);
      
      // GPU mode uses fixed zoom level 4 (pixel size matches at all map zoom levels)
      const zoom = 4;
      const bounds = map.current.getBounds();
      
      console.log(`Rendering GPU tiles at fixed zoom ${zoom}`);
      
      // Calculate all tiles that intersect the current bounds
      const nwTile = lngLatToTile(bounds.getWest(), bounds.getNorth(), zoom);
      const seTile = lngLatToTile(bounds.getEast(), bounds.getSouth(), zoom);
      
      // Clamp tile coordinates to valid range for this zoom level
      const maxTile = Math.pow(2, zoom) - 1;
      const minX = Math.max(0, Math.min(nwTile.x, seTile.x));
      const maxX = Math.min(maxTile, Math.max(nwTile.x, seTile.x));
      const minY = Math.max(0, Math.min(nwTile.y, seTile.y));
      const maxY = Math.min(maxTile, Math.max(nwTile.y, seTile.y));
      
      const newTiles = new Set();
      const tilesToRender = [];
      
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          const tileKey = `${zoom}-${x}-${y}-${dayOfYear}`;
          newTiles.add(tileKey);
          
          // Only render if not already active
          if (!activeTiles.current.has(tileKey)) {
            tilesToRender.push({ x, y, z: zoom });
          }
        }
      }
      
      // Remove tiles that are no longer in view
      for (const oldTileKey of activeTiles.current) {
        if (!newTiles.has(oldTileKey)) {
          const [z, x, y] = oldTileKey.split('-').map(Number);
          const sourceId = `foliage-gpu-${z}-${x}-${y}`;
          const layerId = `foliage-layer-${z}-${x}-${y}`;
          
          if (map.current.getLayer(layerId)) {
            map.current.removeLayer(layerId);
          }
          if (map.current.getSource(sourceId)) {
            map.current.removeSource(sourceId);
          }
          activeTiles.current.delete(oldTileKey);
        }
      }
      
      console.log(`Rendering ${tilesToRender.length} new tiles (${newTiles.size} total visible)`);
      
      // Render and add new tiles
      for (const tile of tilesToRender) {
        const canvas = await processor.generateTile(tile.z, tile.x, tile.y, dayOfYear);
        if (!canvas) continue;
        
        const tileKey = `${tile.z}-${tile.x}-${tile.y}-${dayOfYear}`;
        const sourceId = `foliage-gpu-${tileKey}`;
        const layerId = `foliage-layer-${tileKey}`;
        
        // Convert canvas to blob URL
        canvas.toBlob((blob) => {
          const blobUrl = URL.createObjectURL(blob);
          
          // Get tile bounds
          const tileBbox = tileBounds(tile);
          const coordinates = [
            [tileBbox.west, tileBbox.north],   // NW
            [tileBbox.east, tileBbox.north],   // NE
            [tileBbox.east, tileBbox.south],   // SE
            [tileBbox.west, tileBbox.south]    // SW
          ];
          
          try {
            // Add image source for this tile
            if (!map.current.getSource(sourceId)) {
              map.current.addSource(sourceId, {
                type: "image",
                url: blobUrl,
                coordinates: coordinates
              });
              
              // Add layer for this tile
              map.current.addLayer({
                id: layerId,
                type: "raster",
                source: sourceId,
                paint: { "raster-opacity": 0.85 },
                layout: { "visibility": "visible" }
              }, "state-borders-top");
              
              activeTiles.current.add(tileKey);
            }
          } catch (e) {
            console.error(`Error adding tile ${sourceId}:`, e);
          }
        }, "image/png");
      }
      
    } catch (e) {
      console.error("GPU tile rendering failed:", e);
    } finally {
      setIsProcessing(false);
    }
  };

  // Toggle between 2D and 3D view (currently disabled - terrain not available)
  const toggle3DView = () => {
    if (!map.current) return;
    const newIs3D = !is3DView;
    setIs3DView(newIs3D);
    if (newIs3D) {
      map.current.easeTo({ pitch: 60, bearing: -20, zoom: 4.5, duration: 1000 });
    } else {
      map.current.easeTo({ pitch: 0, bearing: 0, zoom: 3, duration: 1000 });
    }
  };

  // Toggle between CPU mode and GPU mode (Raster mode temporarily disabled)
  const toggleMapMode = () => {
    setMapMode(prev => prev === "cpu" ? "gpu" : "cpu");
  };

  // Main map initialization - set up once on component mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "/style.json",
      center: [-98.5, 39.8],
      zoom: 3,
      pitch: 0,
      bearing: 0,
      interactive: true,
      maxBounds: [[-130, 24], [-65, 50]],
      maxPitch: 85,
      antialias: true,
      transformRequest: (url) => {
        return { url };
      }
    });

    // Re-render GPU tiles on map movement
    map.current.on("move", () => {
      if (mapMode === "gpu" && gpuProcessor.current && geoTiffLoaded) {
        // Debounce tile updates during rapid pans
        if (!map.current._tileUpdateTimeout) {
          updateGPUTiles(gpuProcessor.current, dayOfYearRef.current);
          map.current._tileUpdateTimeout = setTimeout(() => {
            map.current._tileUpdateTimeout = null;
          }, 500);
        }
      }
    });

    map.current.on("load", () => {
      // Note: Terrain layer disabled (was causing 403 errors with OpenTopoMap)
      // Uncomment below to re-enable 3D terrain if you have an alternative DEM source

      // Hide base map layers
      const style = map.current.getStyle();
      if (style && style.layers) {
        style.layers.forEach((layer) => {
          try {
            map.current.setLayoutProperty(layer.id, "visibility", "none");
          } catch {
            // Ignore errors when hiding layers
          }
        });
      }

      // Ocean Background
      map.current.addLayer({
        id: "ocean-background",
        type: "background",
        paint: { "background-color": "#D4E7F5" },
      });

      // State Borders Source (cached locally)
      map.current.addSource("state-borders", {
        type: "geojson",
        data: "/us-states.json"
      });

      // US Terrain Fill (light tan base)
      map.current.addLayer({
        id: "us-terrain",
        type: "fill",
        source: "state-borders",
        paint: { "fill-color": "#E8DCC8", "fill-opacity": 1 },
      });

      // CPU Mode (GeoJSON)
      map.current.addSource("foliage-cpu", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        generateId: true
      });

      map.current.addLayer({
        id: "foliage-layer-cpu",
        type: "fill",
        source: "foliage-cpu",
        paint: {
          "fill-color": foliageColors.none,
          "fill-opacity": 0.85,
          "fill-antialias": false
        },
        layout: { "visibility": mapMode === "cpu" ? "visible" : "none" }
      });

      // GPU Mode (Raster Tiles via Image Source)
      // This will be populated dynamically with rendered canvas tiles
      // We create it lazily on first GPU tile render, not here
      // (placeholder would cause rendering issues)

      // State borders on top
      map.current.addLayer({
        id: "state-borders-top",
        type: "line",
        source: "state-borders",
        paint: { "line-color": "#666666", "line-width": 1.5 },
      });

      // Async load GeoTIFF and states data for CPU and GPU modes
      Promise.all([
        loadGeoTIFF("/SpringBloom_30yr.tif"),
        fetch("/us-states.json").then(res => res.json())
      ]).then(([tiffData, states]) => {
        if (!tiffData) {
          console.error("Failed to load GeoTIFF");
          return;
        }
        
        console.log("Data loaded successfully");
        geoTiffData.current = tiffData;
        statesGeoJSON.current = states;
        
        // Initialize CPU mode
        const foliageGrid = createFoliageGrid(states, tiffData);
        gridCache.current = foliageGrid;
        const source = map.current.getSource("foliage-cpu");
        if (source) {
          console.log("Setting CPU foliage data on map");
          source.setData(foliageGrid);
          
          // Apply initial colors for CPU mode
          if (mapMode === "cpu") {
            console.log("Applying CPU mode colors");
            map.current.setPaintProperty("foliage-layer-cpu", "fill-color", [
              "interpolate", ["linear"], ["get", "spring_day"],
              0, foliageColors.postBloom,
              54 - 20, foliageColors.postBloom,
              54 - 10, foliageColors.canopy,
              54 - 3, foliageColors.peakBloom,
              54, foliageColors.firstBloom,
              54 + 5, foliageColors.firstLeaf,
              54 + 10, foliageColors.budding,
              54 + 15, foliageColors.none,
              200, foliageColors.none,
            ]);
          }
        } else {
          console.warn("foliage-cpu source not found");
        }
        
        // Initialize Raster Tile Processor instead of GeoJSON processor
        (async () => {
          const processor = new RasterTileProcessor();
          const success = await processor.init();
          if (success) {
            processor.loadGeoTIFF(tiffData);
            gpuProcessor.current = processor;
            console.log("Raster tile processor initialized");
            
            // Render initial tiles for the current viewport
            await updateGPUTiles(processor, dayOfYear);
          } else {
            console.warn("Raster tile processor initialization failed");
          }
        })();
        
        setGeoTiffLoaded(true);
      }).catch(err => {
        console.error("Failed to load data:", err);
      });
    });

    return () => {
      if (gpuProcessor.current) {
        gpuProcessor.current.dispose();
      }
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  // Update visible layer when mapMode changes
  useEffect(() => {
    if (!map.current || !map.current.loaded() || !map.current.getStyle()) return;

    try {
      if (map.current.getLayer("foliage-layer-cpu")) {
        map.current.setLayoutProperty("foliage-layer-cpu", "visibility", mapMode === "cpu" ? "visible" : "none");
      }
      if (map.current.getLayer("foliage-layer-gpu")) {
        map.current.setLayoutProperty("foliage-layer-gpu", "visibility", mapMode === "gpu" ? "visible" : "none");
      }
    } catch (e) {
      console.log("Layer visibility update error:", e);
    }
  }, [mapMode]);

  // Sync colors when dayOfYear changes (CPU and GPU modes)
  useEffect(() => {
    if (!map.current) return;

    if (mapMode === "cpu") {
      try {
        map.current.setPaintProperty("foliage-layer-cpu", "fill-color", [
          "interpolate", ["linear"], ["get", "spring_day"],
          0, foliageColors.postBloom,
          dayOfYear - 20, foliageColors.postBloom,
          dayOfYear - 10, foliageColors.canopy,
          dayOfYear - 3, foliageColors.peakBloom,
          dayOfYear, foliageColors.firstBloom,
          dayOfYear + 5, foliageColors.firstLeaf,
          dayOfYear + 10, foliageColors.budding,
          dayOfYear + 15, foliageColors.none,
          200, foliageColors.none,
        ]);
      } catch {
        // CPU mode color update may fail if map is not ready
      }
    } else if (mapMode === "gpu") {
      // GPU mode: render tiles via WebGL
      if (!geoTiffLoaded || !gpuProcessor.current) {
        console.log("GPU mode waiting for data and processor initialization...");
        return;
      }
      
      (async () => {
        await updateGPUTiles(gpuProcessor.current, dayOfYear);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayOfYear, mapMode]);

  return (
    <div style={{ position: "relative" }}>
      <div ref={mapContainer} className="map-container" />

      <div className="map-controls">
        <button
          onClick={toggle3DView}
          className="control-button"
          aria-label={is3DView ? "Switch to top view" : "Switch to side view"}
        >
          {is3DView ? "Top View" : "3D View"}
        </button>
      </div>

      <div className="map-technical-controls">
        <button
          onClick={toggleMapMode}
          className={`tech-button ${mapMode === "gpu" ? "active" : ""}`}
          disabled={isProcessing}
          title={`Rendering Mode: ${mapMode.toUpperCase()}${isProcessing ? " (Processing...)" : ""}`}
        >
          <span>
            {mapMode === "cpu" && "🔧 CPU Mode"}
            {mapMode === "gpu" && "⚡ GPU Mode"}
            {isProcessing && " ⏳"}
          </span>
        </button>
      </div>

      {mapMode === "cpu" && (
        <div className="dev-indicator">
          📍 Sequential CPU Sampling
        </div>
      )}
      
      {mapMode === "gpu" && (
        <div className="dev-indicator">
          ⚡ Vectorized GPU Sampling {isProcessing && "⏳"}
        </div>
      )}
    </div>
  );
};

// --- Helper Functions ---

function createFoliageGrid(statesGeoJSON, geoTiffData) {
  const bbox = [-130, 24, -65, 50];
  const cellSide = 3;
  const grid = turf.squareGrid(bbox, cellSide, { units: "miles" });
  const continentalStates = statesGeoJSON.features.filter(f => f.properties.name !== "Alaska" && f.properties.name !== "Hawaii");
  const filteredFeatures = [];

  for (const square of grid.features) {
    const center = turf.center(square);
    const [lon, lat] = center.geometry.coordinates;
    let intersects = false;
    for (const state of continentalStates) {
      if (turf.booleanPointInPolygon(center, state)) {
        intersects = true;
        break;
      }
    }
    if (!intersects) continue;

    const springDay = sampleGeoTIFFAtPoint(lon, lat, geoTiffData) || 90;
    const clamped = Math.max(50, Math.min(150, springDay));
    filteredFeatures.push({
      type: "Feature",
      geometry: square.geometry,
      properties: { spring_day: clamped }
    });
  }
  
  console.log(`CPU: Generated ${filteredFeatures.length} foliage features`);
  return { type: "FeatureCollection", features: filteredFeatures };
}

function sampleGeoTIFFAtPoint(lon, lat, geoTiffData) {
  const { rasterData, width, height, bbox } = geoTiffData;
  const [west, south, east, north] = bbox;
  const xRatio = (lon - west) / (east - west);
  // GeoTIFF stored north-to-south: row 0 = north, row height-1 = south
  const yRatio = (north - lat) / (north - south);
  const px = Math.floor(xRatio * width);
  const py = Math.floor(yRatio * height);
  if (px < 0 || px >= width || py < 0 || py >= height) return null;
  const val = rasterData[py * width + px];
  return (val < 1 || val > 365) ? null : val;
}

async function loadGeoTIFF(url) {
  try {
    const tiff = await GeoTIFF.fromUrl(url);
    const image = await tiff.getImage();
    const rasterData = await image.readRasters();
    
    // Get bounding box - GeoTIFF.js returns [minX, minY, maxX, maxY] in geographic coords
    // For WGS84: minX=west, minY=south, maxX=east, maxY=north
    const bb = image.getBoundingBox();
    const bbox = [bb[0], bb[1], bb[2], bb[3]];  // [west, south, east, north]
    
    console.log(`[GPU] GeoTIFF bounds: W=${bbox[0].toFixed(2)}, S=${bbox[1].toFixed(2)}, E=${bbox[2].toFixed(2)}, N=${bbox[3].toFixed(2)}`);
    console.log(`[GPU] GeoTIFF metadata: ${image.getWidth()}x${image.getHeight()} pixels`);
    
    // Validate bbox makes geographic sense
    if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
      console.warn(`[GPU] WARNING: Invalid bbox detected! W>E or S>N - format may be unexpected!`);
    }
    
    return {
      rasterData: rasterData[0],
      width: image.getWidth(),
      height: image.getHeight(),
      bbox: bbox,
    };
  } catch (e) {
    console.error("GeoTIFF loading failed:", e);
    return null;
  }
}

export default Map;