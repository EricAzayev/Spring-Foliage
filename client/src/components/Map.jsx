import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import "./Map.css";

const Map = ({ dayOfYear }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [is3DView, setIs3DView] = useState(false);

  const foliageColors = {
    none: "#4B3621",
    budding: "#A67B5B",
    firstLeaf: "#ADFF2F",
    firstBloom: "#DA70D6",
    peakBloom: "#800080",
    canopy: "#228B22",
    postBloom: "#006400",
  };

  // Toggle between 2D and 3D view
  const toggle3DView = () => {
    if (!map.current) return;

    const newIs3D = !is3DView;
    setIs3DView(newIs3D);

    if (newIs3D) {
      // Switch to 3D side view
      map.current.easeTo({
        pitch: 60,
        bearing: 0,
        duration: 1000,
      });
    } else {
      // Switch back to top-down view
      map.current.easeTo({
        pitch: 0,
        bearing: 0,
        duration: 1000,
      });
    }
  };

  useEffect(() => {
    if (map.current) return; // Initialize map only once

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://demotiles.maplibre.org/style.json",
      center: [-98.5, 39.8],
      zoom: 3.5,
      pitch: 0,
      bearing: 0,
      interactive: true,
      maxBounds: [
        [-130, 24], // Southwest coordinates (continental US only)
        [-65, 50], // Northeast coordinates (continental US only)
      ],
    });

    map.current.on("load", () => {
      // Hide all base map layers to remove other countries
      const layers = map.current.getStyle().layers;

      layers.forEach((layer) => {
        // Hide all country/land layers to remove other countries
        try {
          map.current.setLayoutProperty(layer.id, "visibility", "none");
        } catch (e) {
          // Some layers might not support visibility
        }
      });

      // Add a clean ocean background
      map.current.addLayer(
        {
          id: "ocean-background",
          type: "background",
          paint: {
            "background-color": "#D4E7F5",
          },
        },
        layers[0]?.id
      );

      // Add state borders using a simple GeoJSON
      // For now, we'll add a placeholder source that will be replaced with actual data
      map.current.addSource("state-borders", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      map.current.addLayer({
        id: "state-borders-line",
        type: "line",
        source: "state-borders",
        paint: {
          "line-color": "#E4E4E4",
          "line-width": 0.7,
        },
      });
      // Add foliage grid overlay (3-mile squares)
      map.current.addSource("foliage", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      // Base terrain layer for US states (light tan/beige)
      map.current.addLayer({
        id: "us-terrain",
        type: "fill",
        source: "state-borders",
        paint: {
          "fill-color": "#E8DCC8",
          "fill-opacity": 1,
        },
      });

      map.current.addLayer({
        id: "foliage-fill",
        type: "fill",
        source: "foliage",
        paint: {
          "fill-color": foliageColors.none,
          "fill-opacity": 0.85,
        },
      });

      // Add state borders on top of foliage (so they're visible)
      map.current.addLayer({
        id: "state-borders-top",
        type: "line",
        source: "state-borders",
        paint: {
          "line-color": "#666666",
          "line-width": 1.5,
        },
      });

      // Load US states GeoJSON from a public source
      fetch(
        "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json"
      )
        .then((response) => response.json())
        .then((data) => {
          map.current.getSource("state-borders").setData(data);

          // Create 3-mile grid squares with foliage data
          const foliageGrid = createFoliageGrid(data);
          map.current.getSource("foliage").setData(foliageGrid);
        })
        .catch((err) => console.log("Could not load state borders:", err));
    });

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  // Update foliage colors when dayOfYear changes
  useEffect(() => {
    if (!map.current || !map.current.loaded()) return;

    // This will update the foliage layer based on the day
    // For now, we'll use a simple gradient effect from south to north
    try {
      map.current.setPaintProperty("foliage-fill", "fill-color", [
        "interpolate",
        ["linear"],
        ["get", "spring_day"],
        0,
        foliageColors.none,
        dayOfYear - 30,
        foliageColors.none,
        dayOfYear - 20,
        foliageColors.budding,
        dayOfYear - 10,
        foliageColors.firstLeaf,
        dayOfYear,
        foliageColors.firstBloom,
        dayOfYear + 10,
        foliageColors.peakBloom,
        dayOfYear + 20,
        foliageColors.canopy,
        dayOfYear + 30,
        foliageColors.postBloom,
        200,
        foliageColors.postBloom,
      ]);
    } catch (e) {
      console.log("Error updating foliage colors:", e);
    }
  }, [dayOfYear]);

  return (
    <div style={{ position: "relative" }}>
      <div ref={mapContainer} className="map-container" />
      <button
        onClick={toggle3DView}
        className="view-toggle-button"
        aria-label={is3DView ? "Switch to top view" : "Switch to side view"}
      >
        {is3DView ? (
          <>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="3" y="3" width="18" height="18" />
            </svg>
            <span>Top View</span>
          </>
        ) : (
          <>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            </svg>
            <span>3D View</span>
          </>
        )}
      </button>
    </div>
  );
};

// Create foliage data from actual US state boundaries
// Create larger grid squares for better performance
function createFoliageGrid(statesGeoJSON) {
  // Continental US bounds
  const bbox = [-130, 24, -65, 50];
  const cellSide = 5; // miles (increased from 3 for much better performance)
  const options = { units: "miles" };

  // Generate square grid
  const grid = turf.squareGrid(bbox, cellSide, options);

  // Create a single unioned polygon of all continental US states for faster intersection testing
  const continentalStates = statesGeoJSON.features.filter(
    (state) =>
      state.properties.name !== "Alaska" &&
      state.properties.name !== "Hawaii"
  );

  // Use bounding box pre-filter to reduce expensive polygon checks
  const filteredFeatures = [];
  
  for (const square of grid.features) {
    const center = turf.center(square);
    const [lon, lat] = center.geometry.coordinates;

    // Check if this square intersects with any US state
    let intersects = false;
    for (const state of continentalStates) {
      if (turf.booleanPointInPolygon(center, state)) {
        intersects = true;
        break;
      }
    }

    if (!intersects) continue;

    // Calculate spring_day based on latitude
    // Southern (lat ~25): start around day 60 (early March)
    // Northern (lat ~50): start around day 120 (late April)
    const springDay = Math.round(60 + ((lat - 25) / 25) * 60);
    const clampedSpringDay = Math.max(60, Math.min(140, springDay));

    filteredFeatures.push({
      ...square,
      properties: {
        spring_day: clampedSpringDay,
        lat: lat,
        lon: lon,
      },
    });
  }

  return {
    type: "FeatureCollection",
    features: filteredFeatures,
  };
}
// Create major interstate highways data
async function createMajorHighways() {
  // Placeholder function - in a real implementation, fetch and process highway data
};

export default Map;