import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import * as GeoTIFF from "geotiff";
import GPUProcessor from "../utils/gpuProcessor.js";
import "./Map.css";

const Map = ({ dayOfYear }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [is3DView, setIs3DView] = useState(false);
  const [mapMode, setMapMode] = useState("gpu"); // GPU mode now working (samples raster directly)
  const [geoTiffLoaded, setGeoTiffLoaded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const gridCache = useRef(null);
  const gpuProcessor = useRef(null);
  const statesGeoJSON = useRef(null);
  const geoTiffData = useRef(null);

  const foliageColors = {
    none: "#4B3621",
    budding: "#A67B5B",
    firstLeaf: "#C9D96F",
    firstBloom: "#DA70D6",
    peakBloom: "#800080",
    canopy: "#ADFF2F",
    postBloom: "#006400",
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

    // Update zoom level on map move
    map.current.on("move", () => {
      // Zoom level tracking can be added here if needed
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

      // 3. MODULE: GPU Mode (GeoJSON)
      map.current.addSource("foliage-gpu", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        generateId: true
      });

      map.current.addLayer({
        id: "foliage-layer-gpu",
        type: "fill",
        source: "foliage-gpu",
        paint: {
          "fill-color": foliageColors.none,
          "fill-opacity": 0.85,
          "fill-antialias": false
        },
        layout: { "visibility": mapMode === "gpu" ? "visible" : "none" }
      });

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
        
        // Initialize GPU processor
        (async () => {
          const gpu = new GPUProcessor();
          const success = await gpu.init();
          if (success) {
            gpu.loadGeoTIFFTexture(tiffData);
            gpuProcessor.current = gpu;
            console.log("GPU processor initialized");
          } else {
            console.warn("GPU processor initialization failed");
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
    } catch {
      // Layer visibility updates may fail if map is not ready
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
      // Process on GPU - wait for data to load
      if (!geoTiffLoaded) {
        console.log("GPU mode waiting for data to load...");
        return;
      }
      
      if (geoTiffData.current && statesGeoJSON.current && gpuProcessor.current) {
        setIsProcessing(true);
        (async () => {
          try {
            console.log("GPU: Starting GPU processing...");
            const gpuResults = await gpuProcessor.current.processGridGPU(
              statesGeoJSON.current,
              geoTiffData.current,
              dayOfYear
            );
            console.log(`GPU: Got ${gpuResults.features.length} features`);
            
            // Safety check - limit features to prevent MapLibre crashes
            if (gpuResults.features.length > 50000) {
              console.warn(`Too many features (${gpuResults.features.length}), downsampling...`);
              // Keep every Nth feature to reduce count
              const sampleRate = Math.ceil(gpuResults.features.length / 40000);
              gpuResults.features = gpuResults.features.filter((_, i) => i % sampleRate === 0);
              console.log(`Downsampled to ${gpuResults.features.length} features`);
            }
            
            const source = map.current.getSource("foliage-gpu");
            if (source) {
              source.setData(gpuResults);
              // Update colors
              map.current.setPaintProperty("foliage-layer-gpu", "fill-color", [
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
            }
          } catch (e) {
            console.error("GPU processing failed:", e);
          } finally {
            setIsProcessing(false);
          }
        })();
      }
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
    return {
      rasterData: rasterData[0],
      width: image.getWidth(),
      height: image.getHeight(),
      bbox: image.getBoundingBox(),
    };
  } catch {
    // GeoTIFF loading failed, CPU mode will be unavailable
    return null;
  }
}

export default Map;