import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./Map.css";

const Map = ({ dayOfYear }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);

  const foliageColors = {
    none: "#4B3621",
    budding: "#A67B5B",
    firstLeaf: "#ADFF2F",
    firstBloom: "#DA70D6",
    peakBloom: "#800080",
    canopy: "#228B22",
    postBloom: "#006400",
  };

  useEffect(() => {
    if (map.current) return; // Initialize map only once

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://demotiles.maplibre.org/style.json",
      center: [-98.5, 39.8],
      zoom: 3.5,
      pitch: 0,
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

      // Add hillshade for topography (only for US states)
      map.current.addSource("hillshade", {
        type: "raster",
        tiles: ["https://tile.openstreetmap.fr/hillshading/{z}/{x}/{y}.png"],
        tileSize: 256,
      });

      map.current.addLayer({
        id: "hillshade",
        type: "raster",
        source: "hillshade",
        paint: { "raster-opacity": 0.25 },
      });

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

      // Add foliage overlay (initially all dark brown = "none" stage)
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

      // Load US states GeoJSON from a public source
      fetch(
        "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json"
      )
        .then((response) => response.json())
        .then((data) => {
          map.current.getSource("state-borders").setData(data);

          // Use the US states data to create the foliage overlay
          // This ensures the foliage layer matches the actual US boundaries
          const foliageData = createFoliageFromStates(data);
          map.current.getSource("foliage").setData(foliageData);
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

  return <div ref={mapContainer} className="map-container" />;
};

// Create foliage data from actual US state boundaries
function createFoliageFromStates(statesGeoJSON) {
  const features = statesGeoJSON.features
    .filter((state) => {
      const stateName = state.properties.name;
      // Exclude Alaska and Hawaii
      return stateName !== "Alaska" && stateName !== "Hawaii";
    })
    .map((state) => {
      const stateName = state.properties.name;

      // Calculate spring timing based on approximate latitude of each state
      // Get center latitude from state bounds
      const coords = state.geometry.coordinates;
      let centerLat;

      // Simple latitude approximation for each state
      const stateLatitudes = {
        Alabama: 32.8,
        Alaska: 64.2,
        Arizona: 34.0,
        Arkansas: 34.8,
        California: 36.8,
        Colorado: 39.0,
        Connecticut: 41.6,
        Delaware: 39.0,
        Florida: 28.0,
        Georgia: 32.6,
        Hawaii: 20.0,
        Idaho: 44.0,
        Illinois: 40.0,
        Indiana: 40.0,
        Iowa: 42.0,
        Kansas: 38.5,
        Kentucky: 37.5,
        Louisiana: 31.0,
        Maine: 45.5,
        Maryland: 39.0,
        Massachusetts: 42.3,
        Michigan: 44.3,
        Minnesota: 46.0,
        Mississippi: 32.7,
        Missouri: 38.3,
        Montana: 47.0,
        Nebraska: 41.5,
        Nevada: 39.0,
        "New Hampshire": 43.7,
        "New Jersey": 40.0,
        "New Mexico": 34.5,
        "New York": 43.0,
        "North Carolina": 35.5,
        "North Dakota": 47.5,
        Ohio: 40.2,
        Oklahoma: 35.5,
        Oregon: 44.0,
        Pennsylvania: 41.0,
        "Rhode Island": 41.7,
        "South Carolina": 34.0,
        "South Dakota": 44.5,
        Tennessee: 35.8,
        Texas: 31.0,
        Utah: 39.3,
        Vermont: 44.0,
        Virginia: 37.5,
        Washington: 47.5,
        "West Virginia": 38.5,
        Wisconsin: 44.5,
        Wyoming: 43.0,
      };

      centerLat = stateLatitudes[stateName] || 40.0;

      // Calculate spring_day based on latitude
      // Southern states (lat ~25): start around day 60 (early March)
      // Northern states (lat ~50): start around day 120 (late April)

      // Linear interpolation: lat 25 = day 60, lat 50 = day 120
      const springDay = Math.round(60 + ((centerLat - 25) / 25) * 60);
      const clampedSpringDay = Math.max(60, Math.min(140, springDay)); // Clamp between 60-140

      return {
        type: "Feature",
        properties: {
          ...state.properties,
          spring_day: clampedSpringDay,
          center_lat: centerLat,
        },
        geometry: state.geometry,
      };
    });

  return {
    type: "FeatureCollection",
    features: features,
  };
}

export default Map;
