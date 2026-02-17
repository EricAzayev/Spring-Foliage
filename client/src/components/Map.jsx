import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import * as GeoTIFF from "geotiff";
import { TERRAIN_CONFIG } from "../utils/terrainConfig.js";
import "./Map.css";

const Map = ({ dayOfYear }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [is3DView, setIs3DView] = useState(false);
  const [mapMode, setMapMode] = useState("tiles"); // "tiles" or "cpu"
  const [currentZoom, setCurrentZoom] = useState(3);
  const [geoTiffLoaded, setGeoTiffLoaded] = useState(false);
  const gridCache = useRef(null);
  const activeLayerIdx = useRef(1); // Track which double-buffered layer is current

  const MAX_GEN_ZOOM = 10; // Constant indicating what we've generated

  const foliageColors = {
    none: "#4B3621",
    budding: "#A67B5B",
    firstLeaf: "#C9D96F",
    firstBloom: "#DA70D6",
    peakBloom: "#800080",
    canopy: "#ADFF2F",
    postBloom: "#006400",
  };

  // Current day string for tile folder lookup
  const currentSnapDay = dayOfYear;

  // Toggle between 2D and 3D view
  const toggle3DView = () => {
    if (!map.current) return;
    const newIs3D = !is3DView;
    setIs3DView(newIs3D);
    if (newIs3D) {
      map.current.easeTo({ pitch: 60, bearing: -20, zoom: 4.5, duration: 1000 });
      if (map.current.getTerrain()) {
        map.current.setTerrain({ source: "terrain", exaggeration: 2.5 });
      }
    } else {
      map.current.easeTo({ pitch: 0, bearing: 0, zoom: 10, duration: 1000 });
      if (map.current.getTerrain()) {
        map.current.setTerrain({ source: "terrain", exaggeration: 1.5 });
      }
    }
  };

  // Toggle between Tile mode and CPU mode
  const toggleMapMode = () => {
    setMapMode(prev => prev === "tiles" ? "cpu" : "tiles");
  };

  useEffect(() => {
    if (map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://demotiles.maplibre.org/style.json",
      center: [-98.5, 39.8],
      zoom: 3,
      pitch: 0,
      bearing: 0,
      interactive: true,
      maxBounds: [[-130, 24], [-65, 50]],
      maxPitch: 85,
      antialias: true,
      transformRequest: (url, resourceType) => {
        if (resourceType === "Tile") {
          console.log("Requested tile:", url);
        }
        return { url };
      }
    });

    // Update zoom level state
    map.current.on("move", () => {
      const zoom = map.current.getZoom();
      setCurrentZoom(zoom);
      //console.log("Current zoom level:", zoom);
    });

    map.current.on("load", () => {
      // Add terrain source (3D Topography) - uses free OpenTopoMap by default
      map.current.addSource("terrain", TERRAIN_CONFIG);

      map.current.setTerrain({ source: "terrain", exaggeration: 1.5 });

      // Hide base map layers
      const style = map.current.getStyle();
      if (style && style.layers) {
        style.layers.forEach((layer) => {
          try {
            map.current.setLayoutProperty(layer.id, "visibility", "none");
          } catch (e) { }
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

      // --- Double-buffered sources/layers for smooth transitions ---
      [1, 2].forEach(idx => {
        map.current.addSource(`foliage-tiles-${idx}`, {
          type: "raster",
          tiles: [`${window.location.origin}/tiles/day_${String(currentSnapDay).padStart(3, '0')}/{z}/{x}/{y}.png`],
          tileSize: 256,
          minzoom: 5,
          maxzoom: 5,
          bounds: [-125, 24, -66, 50],
        });

        map.current.addLayer({
          id: `foliage-layer-${idx}`,
          type: "raster",
          source: `foliage-tiles-${idx}`,
          paint: {
            "raster-opacity": idx === 1 ? 0.85 : 0,
            "raster-fade-duration": 0
          },
          layout: { "visibility": mapMode === "tiles" ? "visible" : "none" }
        });
      });

      // 2. MODULE: CPU Mode (GeoJSON)
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

      // State borders on top
      map.current.addLayer({
        id: "state-borders-top",
        type: "line",
        source: "state-borders",
        paint: { "line-color": "#666666", "line-width": 1.5 },
      });

      // Async load GeoTIFF for CPU mode
      loadGeoTIFF("/SpringBloom_30yr.tif").then((geoTiffData) => {
        if (!geoTiffData) return;

        fetch("/us-states.json")
          .then(res => res.json())
          .then(data => {
            gridCache.current = createFoliageGrid(data, geoTiffData);
            const source = map.current.getSource("foliage-cpu");
            if (source) {
              source.setData(gridCache.current);
              setGeoTiffLoaded(true);
            }
          });
      });
    });

    return () => {
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
      [1, 2].forEach(idx => {
        if (map.current.getLayer(`foliage-layer-${idx}`)) {
          map.current.setLayoutProperty(`foliage-layer-${idx}`, "visibility", mapMode === "tiles" ? "visible" : "none");
        }
      });
      if (map.current.getLayer("foliage-layer-cpu")) {
        map.current.setLayoutProperty("foliage-layer-cpu", "visibility", mapMode === "cpu" ? "visible" : "none");
      }
    } catch (e) {
      console.warn("Could not update layer visibility:", e);
    }
  }, [mapMode]);

  // Sync tileset when snap day changes
  useEffect(() => {
    const m = map.current;
    if (!m || !m.isStyleLoaded()) return;

    if (mapMode === "tiles") {
      const nextIdx = activeLayerIdx.current === 1 ? 2 : 1;
      const currentIdx = activeLayerIdx.current;

      const source = m.getSource(`foliage-tiles-${nextIdx}`);
      if (source && source.type === "raster") {
        const urlTemplate = `${window.location.origin}/tiles/day_${String(currentSnapDay).padStart(3, '0')}/{z}/{x}/{y}.png`;

        try {
          // 1. Update the hidden layer's source
          source.setTiles([urlTemplate]);

          // 2. Trigger cross-fade
          // We swap opacities. MapLibre will render the new tiles as they load 
          // while the old ones stay visible underneath/above until faded out.
          m.setPaintProperty(`foliage-layer-${nextIdx}`, "raster-opacity", 0.85);
          m.setPaintProperty(`foliage-layer-${currentIdx}`, "raster-opacity", 0);

          activeLayerIdx.current = nextIdx;
        } catch (e) {
          console.error("Error setting tiles:", e);
        }
      }
    }
  }, [currentSnapDay, mapMode]);

  // Sync colors when dayOfYear changes (CPU mode only)
  useEffect(() => {
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
      } catch (e) { }
    }
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
          className={`tech-button ${mapMode === "cpu" ? "active" : ""}`}
          disabled={mapMode === "cpu" && !geoTiffLoaded}
        >
          <span>{mapMode === "tiles" ? "View Technical (CPU)" : "Switch to Raster"}</span>
          {mapMode === "tiles" && !geoTiffLoaded && <span className="loading-dots">...</span>}
        </button>
      </div>

      {mapMode === "cpu" && (
        <div className="dev-indicator">
          ⚠️ CPU Mode: Live rendering enabled (may be slow)
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
    filteredFeatures.push({
      ...square,
      properties: { spring_day: Math.max(50, Math.min(150, springDay)) }
    });
  }
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
  } catch (error) {
    console.error("Error loading GeoTIFF:", error);
    return null;
  }
}

export default Map;