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

const SUPABASE_TILES_URL = "https://hsuqpowsxssezkbpkrwk.supabase.co/storage/v1/object/public/tiles";
const BASE_TERRAIN_COLOR = "#E8DCC8";
const SNOW_ONLY_TERRAIN_COLOR = "#6B5137";
const MIN_VISIBLE_SNOW_CM = 2.0;

const EMPTY_SNOW_COLLECTION = {
  type: "FeatureCollection",
  features: [],
};

const Map = ({ dayOfYear, viewMode, snowDate }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [is3DView, setIs3DView] = useState(false);
  const [mapMode, setMapMode] = useState("gpu");
  const [geoTiffLoaded, setGeoTiffLoaded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuTimeout = useRef(null);
  const gridCache = useRef(null);
  const gpuProcessor = useRef(null);
  const statesGeoJSON = useRef(null);
  const geoTiffData = useRef(null);
  const activeTiles = useRef(new Set()); // Track rendered tile positions (z-x-y)
  const renderGenRef = useRef(0);          // Generation counter to cancel stale renders
  const snowDataCache = useRef(new globalThis.Map());
  const snowLoadGenRef = useRef(0);
  const dayOfYearRef = useRef(dayOfYear);
  const mapModeRef = useRef(mapMode);
  const viewModeRef = useRef(viewMode);
  const geoTiffLoadedRef = useRef(geoTiffLoaded);
  useEffect(() => { dayOfYearRef.current = dayOfYear; }, [dayOfYear]);
  useEffect(() => { mapModeRef.current = mapMode; }, [mapMode]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => { geoTiffLoadedRef.current = geoTiffLoaded; }, [geoTiffLoaded]);

  const foliageColors = {
    none: "#4B3621",
    budding: "#A67B5B",
    firstLeaf: "#C9D96F",
    firstBloom: "#DA70D6",
    peakBloom: "#800080",
    canopy: "#ADFF2F",
    postBloom: "#006400",
  };

  const setSnowDataOnMap = (snowData) => {
    if (!map.current?.getSource("snow-points")) return;
    map.current.getSource("snow-points").setData(snowData);
  };

  const loadSnowData = async (date) => {
    if (!date) return;

    const filename = formatSnowFilename(date);
    const requestGen = ++snowLoadGenRef.current;

    try {
      let snowData = snowDataCache.current.get(filename);
      if (!snowData) {
        const response = await fetch(`/snow_data/${filename}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        snowData = parseSnowTextToGeoJSON(text);
        snowDataCache.current.set(filename, snowData);
      }

      if (requestGen !== snowLoadGenRef.current) return;
      setSnowDataOnMap(snowData);
    } catch (error) {
      console.error(`Failed to load snow data for ${filename}:`, error);
      if (requestGen === snowLoadGenRef.current) {
        setSnowDataOnMap(EMPTY_SNOW_COLLECTION);
      }
    }
  };

  const syncOverlayVisibility = (nextViewMode = viewMode, nextMapMode = mapMode) => {
    if (!map.current || !map.current.loaded() || !map.current.getStyle()) return;

    const showSpring = nextViewMode === "spring" || nextViewMode === "combined";
    const showSnowSurface = nextViewMode === "snow" || nextViewMode === "combined";
    const showSnowPoints = nextViewMode === "combined";

    if (map.current.getLayer("us-terrain")) {
      map.current.setPaintProperty(
        "us-terrain",
        "fill-color",
        nextViewMode === "snow" ? SNOW_ONLY_TERRAIN_COLOR : BASE_TERRAIN_COLOR,
      );
    }

    if (map.current.getLayer("foliage-layer-cpu")) {
      map.current.setLayoutProperty(
        "foliage-layer-cpu",
        "visibility",
        showSpring && nextMapMode === "cpu" ? "visible" : "none",
      );
    }

    for (const posKey of activeTiles.current) {
      const layerId = `foliage-layer-${posKey}`;
      if (map.current.getLayer(layerId)) {
        map.current.setLayoutProperty(
          layerId,
          "visibility",
          showSpring && nextMapMode === "gpu" ? "visible" : "none",
        );
      }
    }

    [0, 1].forEach((slot) => {
      const layerId = `foliage-layer-raster-${slot}`;
      if (map.current.getLayer(layerId)) {
        map.current.setLayoutProperty(
          layerId,
          "visibility",
          showSpring && nextMapMode === "raster" ? "visible" : "none",
        );
      }
    });

    ["snow-heat", "snow-points-glow", "snow-points-fill"].forEach((layerId) => {
      if (map.current.getLayer(layerId)) {
        const isPointLayer = layerId === "snow-points-glow" || layerId === "snow-points-fill";
        map.current.setLayoutProperty(
          layerId,
          "visibility",
          isPointLayer
            ? (showSnowPoints ? "visible" : "none")
            : (showSnowSurface ? "visible" : "none"),
        );
      }
    });
  };

  // Helper function to render GPU tiles for current viewport
  const updateGPUTiles = async (processor, dayOfYear) => {
    if (!processor || !map.current || mapModeRef.current !== "gpu" || viewModeRef.current === "snow") return;

    const gen = ++renderGenRef.current;

    try {
      setIsProcessing(true);

      const zoom = 4;
      const bounds = map.current.getBounds();
      const maxTile = Math.pow(2, zoom) - 1;
      const nwTile = lngLatToTile(bounds.getWest(), bounds.getNorth(), zoom);
      const seTile = lngLatToTile(bounds.getEast(), bounds.getSouth(), zoom);
      const minX = Math.max(0, Math.min(nwTile.x, seTile.x));
      const maxX = Math.min(maxTile, Math.max(nwTile.x, seTile.x));
      const minY = Math.max(0, Math.min(nwTile.y, seTile.y));
      const maxY = Math.min(maxTile, Math.max(nwTile.y, seTile.y));

      const tileList = [];
      for (let x = minX; x <= maxX; x++)
        for (let y = minY; y <= maxY; y++)
          tileList.push({ x, y, z: zoom });

      // Generate all tiles in parallel (WebGL calls are synchronous — Promise.all batches results)
      const canvases = await Promise.all(
        tileList.map(tile => processor.generateTile(tile.z, tile.x, tile.y, dayOfYear))
      );

      // A newer render started while we were working — discard this result
      if (gen !== renderGenRef.current) return;

      const visiblePositions = new Set();

      for (let i = 0; i < tileList.length; i++) {
        const tile = tileList[i];
        const canvas = canvases[i];
        if (!canvas) continue;

        const posKey = `${tile.z}-${tile.x}-${tile.y}`;
        visiblePositions.add(posKey);
        const sourceId = `foliage-gpu-${posKey}`;
        const layerId  = `foliage-layer-${posKey}`;

        // Synchronous data URL — no async callback, no ordering issues
        const dataURL = canvas.toDataURL('image/png');

        if (map.current.getSource(sourceId)) {
          // Source already exists — swap image in-place, layer stays untouched
          map.current.getSource(sourceId).updateImage({ url: dataURL });
        } else {
          const tBounds = tileBounds(tile);
          const coordinates = [
            [tBounds.west, tBounds.north],
            [tBounds.east, tBounds.north],
            [tBounds.east, tBounds.south],
            [tBounds.west, tBounds.south],
          ];
          try {
            map.current.addSource(sourceId, { type: 'image', url: dataURL, coordinates });
            map.current.addLayer({
              id: layerId, type: 'raster', source: sourceId,
              paint: { 'raster-opacity': 0.65 },
              layout: { visibility: viewModeRef.current === "snow" ? 'none' : 'visible' },
            }, 'state-borders-top');
            activeTiles.current.add(posKey);
          } catch (e) {
            console.error(`Error adding tile ${sourceId}:`, e);
          }
        }
      }

      // Remove sources/layers for tiles that scrolled out of view
      for (const posKey of activeTiles.current) {
        if (!visiblePositions.has(posKey)) {
          const sourceId = `foliage-gpu-${posKey}`;
          const layerId  = `foliage-layer-${posKey}`;
          if (map.current.getLayer(layerId))  map.current.removeLayer(layerId);
          if (map.current.getSource(sourceId)) map.current.removeSource(sourceId);
          activeTiles.current.delete(posKey);
        }
      }

      // Kick off idle pre-render of adjacent days so future slider moves are instant
      processor.prerenderRange(tileList, dayOfYear);

    } catch (e) {
      console.error("GPU tile rendering failed:", e);
    } finally {
      setIsProcessing(false);
    }
  };

  // Toggle between 2D and 3D view
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

  // Load GeoTIFF and initialize CPU grid + GPU processor (lazy — skipped for raster-only startup)
  const loadGeoTIFFAndInitProcessors = async (states, currentDay) => {
    if (geoTiffLoadedRef.current) return; // Guard against double-init

    try {
      const data = await loadGeoTIFF("/SpringBloom_30yr.tif");
      if (!data) {
        console.error("GeoTIFF failed to load — CPU/GPU modes unavailable");
        return;
      }

      geoTiffData.current = data;

      // Build CPU grid and hydrate the source
      const grid = createFoliageGrid(states, data);
      gridCache.current = grid;
      if (map.current && map.current.getSource("foliage-cpu")) {
        map.current.getSource("foliage-cpu").setData(grid);
      }

      // Init WebGL GPU processor
      const processor = new RasterTileProcessor();
      const ok = await processor.init();
      if (ok) {
        processor.loadGeoTIFF(data);
        gpuProcessor.current = processor;
      } else {
        console.warn("GPU processor init failed — GPU mode unavailable");
      }

      setGeoTiffLoaded(true);

      // Kick off first GPU render if already in GPU mode
      if (mapModeRef.current === "gpu" && ok && viewModeRef.current !== "snow") {
        updateGPUTiles(processor, currentDay);
      }

      console.log("GeoTIFF + processors ready");
    } catch (e) {
      console.error("loadGeoTIFFAndInitProcessors failed:", e);
    }
  };

  const rasterSlotRef = useRef(0); // alternates 0/1 for double-buffering

  // Update MapLibre raster tile source using double-buffering to avoid flash
  const updateRasterTiles = (day) => {
    if (!map.current) return;
    const dayStr = String(day).padStart(3, '0');
    const tileUrl = `${SUPABASE_TILES_URL}/day_${dayStr}/{z}/{x}/{y}.png`;

    // Alternate between two slots so the old layer stays visible while the new one loads
    const newSlot = rasterSlotRef.current === 0 ? 1 : 0;
    const newSourceId = `foliage-raster-${newSlot}`;
    const newLayerId  = `foliage-layer-raster-${newSlot}`;
    const oldSourceId = `foliage-raster-${rasterSlotRef.current}`;
    const oldLayerId  = `foliage-layer-raster-${rasterSlotRef.current}`;

    // Add new source + layer (initially transparent)
    if (map.current.getSource(newSourceId)) {
      if (map.current.getLayer(newLayerId)) map.current.removeLayer(newLayerId);
      map.current.removeSource(newSourceId);
    }
    map.current.addSource(newSourceId, {
      type: "raster",
      tiles: [tileUrl],
      tileSize: 256,
      minzoom: 4,
      maxzoom: 4,
      bounds: [-130, 24, -65, 50], // CONUS only — prevents requests for ocean/Canada tiles
    });
    map.current.addLayer({
      id: newLayerId,
      type: "raster",
      source: newSourceId,
      paint: {
        "raster-opacity": 0,
        "raster-opacity-transition": { duration: 200, delay: 0 },
      },
      layout: {
        visibility: viewModeRef.current === "snow" || mapModeRef.current !== "raster" ? "none" : "visible",
      },
    }, "state-borders-top");

    rasterSlotRef.current = newSlot;

    // Once the new tiles are loaded, fade in and remove the old layer
    const onIdle = () => {
      map.current.off("idle", onIdle);
      if (!map.current.getLayer(newLayerId)) return;
      // Fade in new layer
      map.current.setPaintProperty(newLayerId, "raster-opacity", 0.65);
      // Remove old layer after the fade (200ms matches transition)
      setTimeout(() => {
        if (map.current.getLayer(oldLayerId))  map.current.removeLayer(oldLayerId);
        if (map.current.getSource(oldSourceId)) map.current.removeSource(oldSourceId);
      }, 250);
    };
    map.current.on("idle", onIdle);
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

    // Re-render GPU tiles once the map settles (pan or zoom complete)
    map.current.on("moveend", () => {
      if (mapModeRef.current === "gpu" && gpuProcessor.current && geoTiffLoadedRef.current && viewModeRef.current !== "snow") {
        updateGPUTiles(gpuProcessor.current, dayOfYearRef.current);
      }
    });

    map.current.on("load", () => {
      // Terrain: AWS Terrarium elevation tiles (free, no key, SRTM 30m)
      map.current.addSource("terrain-dem", {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        tileSize: 256,
        encoding: "terrarium",
        maxzoom: 12,
      });
      map.current.setTerrain({ source: "terrain-dem", exaggeration: 2.0 });

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

      map.current.addSource("snow-points", {
        type: "geojson",
        data: EMPTY_SNOW_COLLECTION,
      });

      map.current.addLayer({
        id: "snow-heat",
        type: "heatmap",
        source: "snow-points",
        paint: {
          "heatmap-weight": [
            "interpolate", ["linear"], ["get", "snowWeight"],
            0, 0,
            1, 0.4,
            4, 1,
          ],
          "heatmap-intensity": 1.15,
          "heatmap-radius": [
            "interpolate", ["linear"], ["zoom"],
            3, 14,
            5, 24,
            7, 32,
          ],
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0.00, "rgba(0,0,0,0)",
            0.20, "#819E8D",
            0.45, "#459194",
            0.70, "#2F3E8B",
            1.00, "#4E1D7D",
          ],
          "heatmap-opacity": 0.82,
        },
        layout: { visibility: viewModeRef.current === "spring" ? "none" : "visible" },
      });

      map.current.addLayer({
        id: "snow-points-glow",
        type: "circle",
        source: "snow-points",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["get", "amountCm"],
            MIN_VISIBLE_SNOW_CM, 1,
            25, 2,
            100, 4,
            250, 7,
            500, 10,
          ],
          "circle-color": "#ffffff",
          "circle-opacity": [
            "interpolate", ["linear"], ["get", "amountCm"],
            MIN_VISIBLE_SNOW_CM, 0.08,
            500, 0.25,
          ],
          "circle-blur": 0.8,
        },
        layout: { visibility: viewModeRef.current === "combined" ? "visible" : "none" },
      });

      map.current.addLayer({
        id: "snow-points-fill",
        type: "circle",
        source: "snow-points",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["get", "amountCm"],
            MIN_VISIBLE_SNOW_CM, 0.8,
            25, 1.6,
            100, 4,
            250, 7,
            500, 10,
          ],
          "circle-color": "#f8fcff",
          "circle-opacity": 0.65,
          "circle-stroke-color": "#d9edf7",
          "circle-stroke-width": 0.6,
        },
        layout: { visibility: viewModeRef.current === "combined" ? "visible" : "none" },
      });

      // Hillshading — draws light/shadow on terrain so elevation reads through foliage
      map.current.addLayer({
        id: "hillshade",
        type: "hillshade",
        source: "terrain-dem",
        paint: {
          "hillshade-exaggeration": 0.6,
          "hillshade-shadow-color": "#3a3a3a",
          "hillshade-highlight-color": "#ffffff",
          "hillshade-accent-color": "#5a4a3a",
          "hillshade-illumination-direction": 335,
        },
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
          "fill-opacity": 0.65,
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

      // If starting in raster mode, show tiles immediately — no GeoTIFF needed
      if (mapModeRef.current === "raster" && viewModeRef.current !== "snow") {
        updateRasterTiles(dayOfYearRef.current);
      }

      loadSnowData(snowDate);

      // Load states (always needed for borders), then conditionally load GeoTIFF
      fetch("/us-states.json").then(res => res.json()).then(states => {
        statesGeoJSON.current = states;
        // For CPU/GPU mode load GeoTIFF now; for raster mode load it in background
        // so switching modes later is fast
        loadGeoTIFFAndInitProcessors(states, dayOfYearRef.current);
      }).catch(err => console.error("Failed to load states:", err));
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
      syncOverlayVisibility(viewMode, mapMode);
      if (mapMode === "raster" && viewMode !== "snow") {
        updateRasterTiles(dayOfYearRef.current);
      }
    } catch (e) {
      console.log("Layer visibility update error:", e);
    }
  }, [mapMode, viewMode]);

  useEffect(() => {
    loadSnowData(snowDate);
  }, [snowDate]);

  // Sync colors when dayOfYear changes (CPU and GPU modes)
  useEffect(() => {
    if (!map.current) return;

    if (viewMode === "snow") {
      return;
    }

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
    } else if (mapMode === "raster") {
      if (map.current && map.current.loaded()) {
        updateRasterTiles(dayOfYear);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayOfYear, mapMode, viewMode]);

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

      <div
        className="mode-switcher"
        onMouseEnter={() => {
          clearTimeout(modeMenuTimeout.current);
          setModeMenuOpen(true);
        }}
        onMouseLeave={() => {
          modeMenuTimeout.current = setTimeout(() => setModeMenuOpen(false), 200);
        }}
      >
        <div className="mode-switcher-label">
          {mapMode === "cpu" && "🔧 CPU"}
          {mapMode === "gpu" && "⚡ GPU"}
          {mapMode === "raster" && "🗺️ Raster"}
          {isProcessing && " ⏳"}
        </div>

        {modeMenuOpen && (
          <div className="mode-switcher-panel">
            <div className="mode-panel-title">Render Mode</div>
            {[
              { id: "cpu",    icon: "🔧", label: "CPU Mode",    desc: "GeoJSON grid, client-side" },
              { id: "gpu",    icon: "⚡", label: "GPU Mode",    desc: "WebGL tiles, client-side" },
              { id: "raster", icon: "🗺️", label: "Raster Mode", desc: "Pre-rendered, from server" },
            ].map(({ id, icon, label, desc }) => (
              <button
                key={id}
                className={`mode-option ${mapMode === id ? "active" : ""}`}
                onClick={() => { setMapMode(id); setModeMenuOpen(false); }}
                disabled={isProcessing && id !== mapMode}
              >
                <span className="mode-option-icon">{icon}</span>
                <span className="mode-option-text">
                  <span className="mode-option-label">{label}</span>
                  <span className="mode-option-desc">{desc}</span>
                </span>
                {mapMode === id && <span className="mode-option-check">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// --- Helper Functions ---

function formatSnowFilename(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `snowdepth_${year}${month}${day}06_m.txt`;
}

function parseSnowTextToGeoJSON(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 3) {
    return EMPTY_SNOW_COLLECTION;
  }

  const header = lines[1].split("|");
  const latitudeIndex = header.indexOf("Latitude");
  const longitudeIndex = header.indexOf("Longitude");
  const amountIndex = header.indexOf("Amount");
  const elevationIndex = header.indexOf("Elevation");
  const stationIdIndex = header.indexOf("Station_Id");
  const nameIndex = header.indexOf("Name");

  if (latitudeIndex === -1 || longitudeIndex === -1 || amountIndex === -1) {
    return EMPTY_SNOW_COLLECTION;
  }

  const features = lines.slice(2)
    .map((line) => line.split("|"))
    .map((columns) => {
      const latitude = Number.parseFloat(columns[latitudeIndex]);
      const longitude = Number.parseFloat(columns[longitudeIndex]);
      const amountCm = Number.parseFloat(columns[amountIndex]);
      const elevationM = Number.parseFloat(columns[elevationIndex]);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(amountCm)) {
        return null;
      }

      if (amountCm < MIN_VISIBLE_SNOW_CM) {
        return null;
      }

      if (longitude < -130 || longitude > -65 || latitude < 24 || latitude > 50) {
        return null;
      }

      const elevationFactor = Number.isFinite(elevationM) ? Math.min(1.4, 0.6 + elevationM / 3000) : 1;
      const snowWeight = Math.max(0, Math.log1p(amountCm) * elevationFactor);

      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [longitude, latitude],
        },
        properties: {
          amountCm,
          elevationM: Number.isFinite(elevationM) ? elevationM : null,
          snowWeight,
          stationId: columns[stationIdIndex] || "",
          name: columns[nameIndex] || "",
        },
      };
    })
    .filter(Boolean);

  return {
    type: "FeatureCollection",
    features,
  };
}

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