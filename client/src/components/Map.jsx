import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import * as GeoTIFF from "geotiff";
import "./Map.css";

const Map = ({ dayOfYear }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [is3DView, setIs3DView] = useState(false);
  const [mapMode, setMapMode] = useState("tiles"); // "tiles" or "cpu"
  const [geoTiffLoaded, setGeoTiffLoaded] = useState(false);
  const gridCache = useRef(null);

  const foliageColors = {
    none: "#4B3621",
    budding: "#A67B5B",
    firstLeaf: "#C9D96F",
    firstBloom: "#DA70D6",
    peakBloom: "#800080",
    canopy: "#ADFF2F",
    postBloom: "#006400",
  };

  // Available days in the pre-generated tile folders
  const availableDays = [53, 54, 55, 56, 57, 58, 59, 60, 61, 62];

  // Helper to find the nearest snap day for the tileset
  const getSnapDay = (day) => {
    return availableDays.reduce((prev, curr) =>
      Math.abs(curr - day) < Math.abs(prev - day) ? curr : prev
    );
  };

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
      map.current.easeTo({ pitch: 0, bearing: 0, zoom: 3.5, duration: 1000 });
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
      zoom: 3.5,
      pitch: 0,
      bearing: 0,
      interactive: true,
      maxBounds: [[-130, 24], [-65, 50]],
      maxPitch: 85,
      antialias: true,
    });

    map.current.on("load", () => {
      // Add terrain source
      map.current.addSource("terrain", {
        type: "raster-dem",
        url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
        tileSize: 256,
        maxzoom: 14,
      });

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

      // State Borders Source
      map.current.addSource("state-borders", {
        type: "geojson",
        data: "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json"
      });

      // US Terrain Fill (light tan base)
      map.current.addLayer({
        id: "us-terrain",
        type: "fill",
        source: "state-borders",
        paint: { "fill-color": "#E8DCC8", "fill-opacity": 1 },
      });

      // 1. MODULE: Tiles Mode
      const snapDay = getSnapDay(dayOfYear);
      map.current.addSource("foliage-tiles", {
        type: "raster",
        tiles: [`${window.location.origin}/tiles/day_${String(snapDay).padStart(3, '0')}/{z}/{x}/{y}.png`],
        tileSize: 256,
        minzoom: 4,
        maxzoom: 10,
      });

      map.current.addLayer({
        id: "foliage-layer-tiles",
        type: "raster",
        source: "foliage-tiles",
        paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 },
        layout: { "visibility": mapMode === "tiles" ? "visible" : "none" }
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

        fetch("https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json")
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
    if (!map.current || !map.current.loaded()) return;

    map.current.setLayoutProperty("foliage-layer-tiles", "visibility", mapMode === "tiles" ? "visible" : "none");
    map.current.setLayoutProperty("foliage-layer-cpu", "visibility", mapMode === "cpu" ? "visible" : "none");
  }, [mapMode]);

  // Sync tileset/colors when dayOfYear changes
  useEffect(() => {
    if (!map.current || !map.current.loaded()) return;

    if (mapMode === "tiles") {
      const source = map.current.getSource("foliage-tiles");
      if (source) {
        const snapDay = getSnapDay(dayOfYear);
        source.setTiles([`${window.location.origin}/tiles/day_${String(snapDay).padStart(3, '0')}/{z}/{x}/{y}.png`]);
      }
    } else if (mapMode === "cpu") {
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
          {is3DView ? (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" /></svg>
              <span>Top View</span>
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></svg>
              <span>3D View</span>
            </>
          )}
        </button>

        <button
          onClick={toggleMapMode}
          className={`control-button mode-toggle ${mapMode === "cpu" ? "active" : ""}`}
          disabled={mapMode === "cpu" && !geoTiffLoaded}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2v10m0 0l-4-4m4 4l4-4" />
            <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{mapMode === "tiles" ? "GeoTIFF (CPU)" : "Raster (Tiles)"}</span>
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