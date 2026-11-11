import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import * as GeoTIFF from "geotiff";
import RasterTileProcessor from "../utils/rasterTileProcessor.js";
import { SUPABASE_SNOW_TILES_URL, fetchSnowTileManifest } from "../utils/snowTiles.js";
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
const SNOW_TILES_URL_PREFIX = SUPABASE_SNOW_TILES_URL;
const DEFAULT_SNOW_TILE_MANIFEST = {
  dates: [],
  minzoom: 4,
  maxzoom: 4,
};
// z4 tile x=4,y=5 sits at the CONUS interior, so it exists for every day the
// tile generator ran for (it only covers the CONUS bbox). x=0,y=0 never does.
const RASTER_TILE_CHECK_URL = (day) => `${SUPABASE_TILES_URL}/day_${String(day).padStart(3, "0")}/4/4/5.png`;

const detectGpuInfo = () => {
  if (typeof document === "undefined") {
    return { supported: false, isNvidia: false, renderer: "", vendor: "" };
  }

  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  if (!gl) {
    return { supported: false, isNvidia: false, renderer: "", vendor: "" };
  }

  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const vendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
  const details = `${vendor ?? ""} ${renderer ?? ""}`.toLowerCase();

  return {
    supported: true,
    isNvidia: details.includes("nvidia"),
    renderer: renderer ? String(renderer) : "",
    vendor: vendor ? String(vendor) : "",
  };
};

const isMobile = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : ""
);

const logTileDataset = (label, payload) => {
  console.log(`[Map Tiles] ${label}`, payload);
};

const Map = ({ dayOfYear, viewMode, snowDate }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [is3DView, setIs3DView] = useState(false);
  const [mapMode, setMapMode] = useState("gpu");
  const [modeStatus, setModeStatus] = useState("");
  const [modeStatusTone, setModeStatusTone] = useState("neutral");
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
  const snowRasterSlotRef = useRef(0);
  const snowRasterEpochRef = useRef(0);   // cancel stale snow tile updates
  const terrainEnabledRef = useRef(false);
  const snowTileManifestRef = useRef(null);
  const snowWarningShownRef = useRef(false);
  const dayOfYearRef = useRef(dayOfYear);
  const mapModeRef = useRef(mapMode);
  const viewModeRef = useRef(viewMode);
  const geoTiffLoadedRef = useRef(geoTiffLoaded);
  const gpuInfoRef = useRef(null);
  const modeRequestRef = useRef(0);
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

  const removeSnowRasterLayers = () => {
    if (!map.current) return;

    [0, 1].forEach((slot) => {
      const layerId = `snow-raster-layer-${slot}`;
      const sourceId = `snow-raster-${slot}`;
      if (map.current.getLayer(layerId)) map.current.removeLayer(layerId);
      if (map.current.getSource(sourceId)) map.current.removeSource(sourceId);
    });
  };

  const loadSnowTileManifest = async () => {
    if (snowTileManifestRef.current) return snowTileManifestRef.current;

    try {
      const manifest = await fetchSnowTileManifest();
      snowTileManifestRef.current = {
        dates: Array.isArray(manifest.dates) ? manifest.dates : [],
        minzoom: Number.isFinite(manifest.minzoom) ? manifest.minzoom : DEFAULT_SNOW_TILE_MANIFEST.minzoom,
        maxzoom: Number.isFinite(manifest.maxzoom) ? manifest.maxzoom : DEFAULT_SNOW_TILE_MANIFEST.maxzoom,
      };
      return snowTileManifestRef.current;
    } catch (error) {
      console.warn("Snow tile manifest unavailable:", error);
      snowTileManifestRef.current = DEFAULT_SNOW_TILE_MANIFEST;
      return snowTileManifestRef.current;
    }
  };

  const updateSnowRasterTiles = async (date) => {
    if (!map.current || !date) return;

    const manifest = await loadSnowTileManifest();
    if (!map.current) return;

    const dayKey = formatSnowDayKey(date);
    if (!manifest.dates.includes(dayKey)) {
      removeSnowRasterLayers();
      if (!snowWarningShownRef.current) {
        console.warn(
          `Snow tiles for ${dayKey} are not available. Run snow_data_generator/build_daily_snow_surfaces.py and snow_data_generator/generate_snow_tiles.py to create them.`
        );
        snowWarningShownRef.current = true;
      }
      return;
    }

    snowWarningShownRef.current = false;
    const tileUrl = `${SNOW_TILES_URL_PREFIX}/${dayKey}/{z}/{x}/{y}.png`;

    logTileDataset("snow raster source", {
      viewMode: viewModeRef.current,
      mapMode: mapModeRef.current,
      snowDate: dayKey,
      tileUrl,
      minzoom: manifest.minzoom,
      maxzoom: manifest.maxzoom,
      availableDates: manifest.dates.length,
    });

    // Double-buffered persistent slots with an epoch guard: fast snow-date
    // changes must never interleave (stale idle handlers racing each other
    // could remove a layer the next update just added, leaving opacity at 0).
    // setTiles keeps MapLibre's tile cache, so revisited dates load instantly.
    const epoch = ++snowRasterEpochRef.current;
    const newSlot = snowRasterSlotRef.current === 0 ? 1 : 0;
    const newSourceId = `snow-raster-${newSlot}`;
    const newLayerId = `snow-raster-layer-${newSlot}`;
    const oldLayerId = `snow-raster-layer-${snowRasterSlotRef.current}`;
    const layerVisible = viewModeRef.current !== "spring";

    const existingSource = map.current.getSource(newSourceId);
    if (existingSource) {
      existingSource.setTiles([tileUrl]);
      if (map.current.getLayer(newLayerId)) {
        map.current.setLayoutProperty(newLayerId, "visibility", layerVisible ? "visible" : "none");
      }
    } else {
      map.current.addSource(newSourceId, {
        type: "raster",
        tiles: [tileUrl],
        tileSize: 256,
        minzoom: manifest.minzoom,
        maxzoom: manifest.maxzoom,
        bounds: [-130, 24, -65, 50],
      });
    }
    if (!map.current.getLayer(newLayerId)) {
      map.current.addLayer({
        id: newLayerId,
        type: "raster",
        source: newSourceId,
        paint: {
          "raster-opacity": 0,
          "raster-opacity-transition": { duration: 250, delay: 0 },
        },
        layout: {
          visibility: layerVisible ? "visible" : "none",
        },
      }, "state-borders-top");
    }

    snowRasterSlotRef.current = newSlot;

    // Fade on this source's own load state, not map "idle" (terrain can keep
    // the map non-idle indefinitely — see fadeWhenSourceLoaded).
    fadeWhenSourceLoaded(newSourceId, () => {
      if (snowRasterEpochRef.current !== epoch) return;
      if (!map.current.getLayer(newLayerId)) return;
      if (map.current.getLayer(oldLayerId)) {
        map.current.setPaintProperty(oldLayerId, "raster-opacity", 0);
      }
      map.current.setPaintProperty(newLayerId, "raster-opacity", 0.78);
      map.current.triggerRepaint();
    });
  };

  const syncOverlayVisibility = (nextViewMode = viewMode, nextMapMode = mapMode) => {
    if (!map.current || !map.current.loaded() || !map.current.getStyle()) return;

    const showSpring = nextViewMode === "spring" || nextViewMode === "combined";
    const showSnowSurface = nextViewMode === "snow" || nextViewMode === "combined";

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

    ["snow-raster-layer-0", "snow-raster-layer-1"].forEach((layerId) => {
      if (map.current.getLayer(layerId)) {
        map.current.setLayoutProperty(layerId, "visibility", showSnowSurface ? "visible" : "none");
      }
    });
  };

  const getGpuInfo = () => {
    if (!gpuInfoRef.current) {
      gpuInfoRef.current = detectGpuInfo();
    }
    return gpuInfoRef.current;
  };

  const isRasterAvailable = async (day = dayOfYearRef.current) => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 2500);

    try {
      const response = await fetch(RASTER_TILE_CHECK_URL(day), {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const resolveRenderMode = async (requestedMode = null) => {
    const gpuInfo = getGpuInfo();

    if (requestedMode === "cpu") {
      return { mode: "cpu", status: "", tone: "neutral" };
    }

    if (requestedMode === "gpu") {
      if (gpuInfo.isNvidia) return { mode: "gpu", status: "", tone: "neutral" };
      if (await isRasterAvailable()) {
        return {
          mode: "raster",
          status: "NVIDIA GPU not detected, using Raster Mode.",
          tone: "info",
        };
      }
      return {
        mode: "cpu",
        status: "NVIDIA GPU not detected and Raster Mode is unavailable, using CPU Mode.",
        tone: "warning",
      };
    }

    if (requestedMode === "raster") {
      if (await isRasterAvailable()) {
        return { mode: "raster", status: "", tone: "neutral" };
      }
      if (gpuInfo.isNvidia) {
        return {
          mode: "gpu",
          status: "Raster Mode is unavailable, using NVIDIA GPU Mode.",
          tone: "warning",
        };
      }
      return {
        mode: "cpu",
        status: "Raster Mode is unavailable and NVIDIA GPU is not detected, using CPU Mode.",
        tone: "warning",
      };
    }

    if (gpuInfo.isNvidia) {
      return { mode: "gpu", status: "", tone: "neutral" };
    }

    if (await isRasterAvailable()) {
      return {
        mode: "raster",
        status: "NVIDIA GPU not detected, using Raster Mode.",
        tone: "info",
      };
    }

    return {
      mode: "cpu",
      status: "NVIDIA GPU not detected and Raster Mode is unavailable, using CPU Mode.",
      tone: "warning",
    };
  };

  const handleModeSelection = async (requestedMode) => {
    setModeMenuOpen(false);
    const requestId = ++modeRequestRef.current;
    const resolution = await resolveRenderMode(requestedMode);

    if (requestId !== modeRequestRef.current) {
      return;
    }

    mapModeRef.current = resolution.mode;
    setMapMode(resolution.mode);
    setModeStatus(resolution.status);
    setModeStatusTone(resolution.tone);
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

      logTileDataset("gpu render batch", {
        viewMode: viewModeRef.current,
        dayOfYear,
        zoom,
        tileCount: tileList.length,
        firstTile: tileList[0] ?? null,
        lastTile: tileList[tileList.length - 1] ?? null,
      });

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
            // Error adding tile
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

      // Terrain-draped image layers can miss their first rasterization when
      // added between frames — force a repaint so the cold-start render
      // doesn't depend on the user's first camera event.
      map.current.triggerRepaint();

      // Kick off idle pre-render of adjacent days so future slider moves are instant
      processor.prerenderRange(tileList, dayOfYear);

    } catch (e) {
      // GPU tile rendering failed
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
      // Terrain draping (setTerrain) is only needed for the pitched 3D view.
      // At startup the map stays flat: without it, raster/image layers aren't
      // DEM-draped (no first-drape repaint quirk) and the map's "idle" event
      // fires normally. Hillshade still renders from the DEM source itself.
      if (!terrainEnabledRef.current) {
        map.current.setTerrain({ source: "terrain-dem", exaggeration: 2.0 });
        terrainEnabledRef.current = true;
      }
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
        // GeoTIFF failed to load — CPU/GPU modes unavailable
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
        // GPU processor init failed — GPU mode unavailable
      }

      setGeoTiffLoaded(true);

      // Kick off first GPU render if already in GPU mode
      if (mapModeRef.current === "gpu" && ok && viewModeRef.current !== "snow") {
        updateGPUTiles(processor, currentDay);
      }

      // GeoTIFF + processors ready
    } catch (e) {
      // loadGeoTIFFAndInitProcessors failed
    }
  };

  const rasterSlotRef = useRef(0); // alternates 0/1 for double-buffering
  const rasterEpochRef = useRef(0); // cancel stale raster updates

  // Run `apply` once a raster source finishes loading (or after a grace
  // timeout). Uses the source's own "sourcedata" state rather than the map's
  // global "idle" event, which can stay pending forever when terrain
  // (raster-dem) is enabled — leaving updates stuck at opacity 0.
  const fadeWhenSourceLoaded = (sourceId, apply) => {
    if (!map.current) { apply(); return; }
    const onData = (e) => {
      if (e.sourceId !== sourceId || !e.isSourceLoaded) return;
      map.current.off("sourcedata", onData);
      clearTimeout(grace);
      apply();
    };
    map.current.on("sourcedata", onData);
    // Apply early (opacity transition handles a not-yet-loaded source
    // gracefully — tiles appear as they land), and let onData also catch
    // late loads on slow connections (apply is idempotent).
    const grace = setTimeout(apply, 1500);
  };

  // Update MapLibre raster tile source using double-buffering to avoid flash
  const updateRasterTiles = async (day) => {
    if (!map.current) return;
    // Probe availability only while raster mode isn't active yet. Probing on
    // every update adds a network round-trip per scroll step, which made the
    // scroller lag behind the UI (GPU mode has no equivalent hop).
    if (mapModeRef.current !== "raster") {
      const resolution = await resolveRenderMode("raster");
      if (resolution.mode !== "raster") {
        if (mapModeRef.current !== resolution.mode) {
          mapModeRef.current = resolution.mode;
          setMapMode(resolution.mode);
        }
        setModeStatus(resolution.status);
        setModeStatusTone(resolution.tone);
        return;
      }
    }

    // Epoch guard: fast scrolling (drag, arrow keys) can stack up updates;
    // only the newest one may fade in. Superseded handlers bow out instead of
    // racing each other and leaving the map stuck at opacity 0.
    const epoch = ++rasterEpochRef.current;
    const dayStr = String(day).padStart(3, '0');
    const tileUrl = `${SUPABASE_TILES_URL}/day_${dayStr}/{z}/{x}/{y}.png`;

    logTileDataset("spring raster source", {
      viewMode: viewModeRef.current,
      mapMode: mapModeRef.current,
      dayOfYear: day,
      tileUrl,
      minzoom: 4,
      maxzoom: 4,
    });

    // Double-buffered persistent slots: swap the day on the back buffer via
    // setTiles (keeps MapLibre's tile cache, so revisited days load instantly)
    // while the front buffer stays visible, then fade across.
    const newSlot = rasterSlotRef.current === 0 ? 1 : 0;
    const newSourceId = `foliage-raster-${newSlot}`;
    const newLayerId  = `foliage-layer-raster-${newSlot}`;
    const oldLayerId  = `foliage-layer-raster-${rasterSlotRef.current}`;
    const layerVisible = viewModeRef.current !== "snow" && mapModeRef.current === "raster";

    const existingSource = map.current.getSource(newSourceId);
    if (existingSource) {
      existingSource.setTiles([tileUrl]);
      if (map.current.getLayer(newLayerId)) {
        map.current.setLayoutProperty(newLayerId, "visibility", layerVisible ? "visible" : "none");
      }
    } else {
      map.current.addSource(newSourceId, {
        type: "raster",
        tiles: [tileUrl],
        tileSize: 256,
        minzoom: 4,
        maxzoom: 4,
      });
    }
    if (!map.current.getLayer(newLayerId)) {
      map.current.addLayer({
        id: newLayerId,
        type: "raster",
        source: newSourceId,
        paint: {
          "raster-opacity": 0,
          "raster-opacity-transition": { duration: 200, delay: 0 },
        },
        layout: {
          visibility: layerVisible ? "visible" : "none",
        },
      }, "state-borders-top");
    }

    rasterSlotRef.current = newSlot;

    rasterSlotRef.current = newSlot;

    // Once the new day's tiles are loaded, fade in and dim the old slot.
    // Don't rely on the map's global "idle" event: with terrain (raster-dem)
    // enabled the map can stay non-idle indefinitely, which left the new
    // layer stuck at opacity 0 until the user happened to interact.
    fadeWhenSourceLoaded(newSourceId, () => {
      if (rasterEpochRef.current !== epoch) return;
      if (!map.current.getLayer(newLayerId)) return;
      if (map.current.getLayer(oldLayerId)) {
        map.current.setPaintProperty(oldLayerId, "raster-opacity", 0);
      }
      map.current.setPaintProperty(newLayerId, "raster-opacity", 0.65);
      // Terrain-draped raster layers can miss their repaint when faded in
      // between frames — force one so cold-start paint isn't dependent on a
      // later camera event.
      map.current.triggerRepaint();
    });
  };

  // Main map initialization - set up once on component mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (map.current) return;

    let cancelled = false;

    const initializeMap = async () => {
      // CONUS extent + a small margin, so the tips (Maine east, Florida south)
      // fit and labels aren't clipped. The most-zoomed-out view fits exactly
      // this region and panning/zooming out can't go past it. The south edge
      // stays above lat ~21.94° so a tall viewport never requests the
      // never-generated z4 tile row y7 (0–21.9°N) at startup.
      const CONUS_BOUNDS = [[-127.5, 23.5], [-61, 52.5]];
      // Raster is the default startup mode unconditionally: most visitors are
      // on mobile or devices without a useful WebGL GPU string, raster needs
      // no GeoTIFF download/decode, and its tiles come from the CDN. GPU mode
      // stays one click away in the modes menu (it lazy-loads the GeoTIFF on
      // demand). No network round-trip gates map creation.
      const preferredMode = { mode: "raster", status: "", tone: "neutral" };
      if (cancelled) return;

      mapModeRef.current = preferredMode.mode;
      setMapMode(preferredMode.mode);
      setModeStatus(preferredMode.status);
      setModeStatusTone(preferredMode.tone);

      map.current = new maplibregl.Map({
        container: mapContainer.current,
        style: "/style.json",
        center: [-98.5, 39.8],
        zoom: 3,
        pitch: 0,
        bearing: 0,
        interactive: true,
        maxBounds: CONUS_BOUNDS,
        maxPitch: 85,
        antialias: true,
        transformRequest: (url) => {
          return { url };
        }
      });

      // Snap the initial view to the full-US fit (overrides the fixed zoom
      // above, whose fit depends on viewport size — this doesn't).
      map.current.on("load", () => {
        map.current.fitBounds(CONUS_BOUNDS, { padding: 0, duration: 0 });
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
          // Keep DEM/hillshade inside North America — stops the gray hillshade
          // smear the renderer draws on the ocean at the world's edge
          bounds: [-170, 15, -50, 75],
        });
        // NOTE: setTerrain is intentionally NOT called here — startup stays
        // flat so the first GPU/raster paint isn't a terrain-drape render.
        // Terrain engages when the user first toggles the 3D view.

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
          layout: { "visibility": preferredMode.mode === "cpu" ? "visible" : "none" }
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

        updateSnowRasterTiles(snowDate);

        // Load states (always needed for borders). The GeoTIFF is loaded
        // lazily: it's only required for cpu/gpu rendering, so raster-only
        // startups skip the ~3MB download + main-thread decode entirely.
        // Switching to cpu/gpu later triggers the load on demand (see the
        // mapMode effect), so the tradeoff is a slower first mode switch.
        fetch("/us-states.json").then(res => res.json()).then(states => {
          statesGeoJSON.current = states;
          if (mapModeRef.current === "cpu" || mapModeRef.current === "gpu") {
            loadGeoTIFFAndInitProcessors(states, dayOfYearRef.current);
          }
        }).catch(err => console.error("Failed to load states:", err));
      });
    };
    initializeMap();

    return () => {
      cancelled = true;
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
      } else if ((mapMode === "cpu" || mapMode === "gpu") && !geoTiffLoadedRef.current && statesGeoJSON.current) {
        loadGeoTIFFAndInitProcessors(statesGeoJSON.current, dayOfYearRef.current);
      }
    } catch (e) {
      // Layer visibility update error
    }
  }, [mapMode, viewMode]);

  useEffect(() => {
    if (map.current && map.current.loaded()) {
      updateSnowRasterTiles(snowDate);
    }
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
        // GPU mode waiting for data and processor initialization...
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

        {modeStatus && (
          <div className={`mode-status mode-status-${modeStatusTone}`} aria-live="polite">
            {modeStatus}
          </div>
        )}

        {modeMenuOpen && (
          <div className="mode-switcher-panel">
            <div className="mode-panel-title">Render Mode</div>
            {[
              { id: "cpu",    icon: "🔧", label: "CPU Mode",    desc: isMobile ? "Not available on mobile" : "GeoJSON grid, client-side" },
              { id: "gpu",    icon: "⚡", label: "GPU Mode",    desc: isMobile ? "Not available on mobile" : "WebGL tiles, client-side" },
              { id: "raster", icon: "🗺️", label: "Raster Mode", desc: "Pre-rendered, from server" },
            ].map(({ id, icon, label, desc }) => (
              <button
                key={id}
                className={`mode-option ${mapMode === id ? "active" : ""}`}
                onClick={() => handleModeSelection(id)}
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

function formatSnowDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
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
  
  // CPU: Generated foliage features
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
    
    // [GPU] GeoTIFF bounds
    // [GPU] GeoTIFF metadata
    
    // Validate bbox makes geographic sense
    if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
      // [GPU] WARNING: Invalid bbox detected! W>E or S>N - format may be unexpected!
    }
    
    return {
      rasterData: rasterData[0],
      width: image.getWidth(),
      height: image.getHeight(),
      bbox: bbox,
    };
  } catch (e) {
    // GeoTIFF loading failed
    return null;
  }
}

export default Map;