import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
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

      // Add terrain/elevation data source
      map.current.addSource("terrain", {
        type: "raster-dem",
        url: "https://demotiles.maplibre.org/terrain-tiles/tiles.json",
        tileSize: 256,
      });

      // Set terrain exaggeration for 3D effect
      map.current.setTerrain({
        source: "terrain",
        exaggeration: 1.5,
      });

      // Add hillshade for dramatic topography
      map.current.addSource("hillshade", {
        type: "raster",
        tiles: ["https://tile.openstreetmap.fr/hillshading/{z}/{x}/{y}.png"],
        tileSize: 256,
      });

      map.current.addLayer({
        id: "hillshade",
        type: "raster",
        source: "hillshade",
        paint: {
          "raster-opacity": 0.5,
          "raster-brightness-min": 0.3,
          "raster-brightness-max": 1.0,
        },
      });

      // Add contour lines for elevation
      map.current.addLayer({
        id: "terrain-hillshade",
        type: "hillshade",
        source: "terrain",
        paint: {
          "hillshade-exaggeration": 0.8,
          "hillshade-shadow-color": "#473B24",
          "hillshade-highlight-color": "#FFFFFF",
          "hillshade-accent-color": "#A67B5B",
        },
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

      // Add major interstate highways for character
      map.current.addSource("highways", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      map.current.addLayer({
        id: "highways-line",
        type: "line",
        source: "highways",
        paint: {
          "line-color": "#B6B6B6",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            3,
            0.8,
            6,
            1.5,
            9,
            2.5,
          ],
          "line-opacity": 0.6,
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

      // Load major interstate highways
      createMajorHighways().then((highwayData) => {
        map.current.getSource("highways").setData(highwayData);
      });
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

// Create major interstate highways data
async function createMajorHighways() {
  // Major interstate highways with approximate coordinates
  const highways = [
    // I-5 (West Coast: Seattle to San Diego)
    {
      name: "I-5",
      coords: [
        [-122.3, 47.6],
        [-122.5, 45.5],
        [-121.5, 43.0],
        [-122.0, 40.0],
        [-121.5, 38.5],
        [-120.0, 36.0],
        [-118.2, 34.0],
        [-117.2, 32.7],
      ],
    },

    // I-10 (Southern: LA to Jacksonville)
    {
      name: "I-10",
      coords: [
        [-118.2, 34.0],
        [-114.0, 33.5],
        [-111.0, 33.4],
        [-110.0, 32.2],
        [-106.5, 31.8],
        [-103.5, 31.5],
        [-100.0, 30.5],
        [-97.7, 30.3],
        [-95.4, 29.8],
        [-91.0, 30.4],
        [-89.0, 30.1],
        [-87.2, 30.4],
        [-85.0, 30.4],
        [-81.7, 30.3],
      ],
    },

    // I-95 (East Coast: Miami to Maine)
    {
      name: "I-95",
      coords: [
        [-80.2, 25.8],
        [-80.2, 26.7],
        [-80.1, 28.5],
        [-81.3, 29.7],
        [-81.0, 30.3],
        [-80.9, 32.0],
        [-79.9, 33.0],
        [-78.9, 34.0],
        [-77.9, 35.8],
        [-77.5, 38.9],
        [-75.5, 39.7],
        [-75.2, 40.0],
        [-74.0, 40.7],
        [-73.8, 41.0],
        [-72.9, 41.3],
        [-71.4, 41.8],
        [-71.1, 42.4],
        [-70.3, 43.7],
        [-69.8, 44.3],
        [-68.8, 45.4],
      ],
    },

    // I-80 (Northern: San Francisco to New York)
    {
      name: "I-80",
      coords: [
        [-122.4, 37.8],
        [-121.0, 38.5],
        [-120.0, 39.3],
        [-117.0, 40.8],
        [-114.0, 41.1],
        [-111.9, 41.0],
        [-110.0, 41.3],
        [-107.0, 41.2],
        [-104.9, 39.7],
        [-102.0, 41.0],
        [-100.0, 41.2],
        [-96.5, 41.3],
        [-95.9, 41.2],
        [-93.6, 41.6],
        [-90.7, 41.5],
        [-88.0, 41.8],
        [-87.6, 41.8],
        [-85.0, 41.7],
        [-83.0, 41.4],
        [-81.7, 41.5],
        [-80.5, 40.4],
        [-79.0, 40.4],
        [-77.0, 40.3],
        [-76.0, 40.2],
        [-75.2, 40.0],
        [-74.0, 40.7],
      ],
    },

    // I-40 (Mid-latitude: Barstow to Wilmington)
    {
      name: "I-40",
      coords: [
        [-117.0, 34.9],
        [-114.0, 35.0],
        [-111.0, 35.2],
        [-109.0, 35.1],
        [-106.6, 35.1],
        [-104.0, 35.5],
        [-103.0, 35.2],
        [-100.3, 35.2],
        [-97.5, 35.5],
        [-95.4, 35.4],
        [-94.0, 35.4],
        [-92.3, 35.2],
        [-90.0, 35.1],
        [-89.9, 35.2],
        [-88.0, 35.0],
        [-86.8, 36.2],
        [-85.0, 36.0],
        [-84.0, 35.5],
        [-82.5, 35.6],
        [-81.0, 35.8],
        [-79.0, 36.0],
        [-78.0, 35.5],
        [-77.9, 34.2],
      ],
    },

    // I-90 (Northern: Seattle to Boston)
    {
      name: "I-90",
      coords: [
        [-122.3, 47.6],
        [-119.0, 47.0],
        [-117.4, 47.7],
        [-116.0, 47.7],
        [-114.0, 46.9],
        [-112.0, 46.6],
        [-110.0, 45.8],
        [-108.5, 45.8],
        [-104.0, 44.1],
        [-103.0, 43.7],
        [-100.0, 43.5],
        [-96.7, 43.5],
        [-93.2, 44.0],
        [-91.0, 43.8],
        [-90.0, 43.0],
        [-87.9, 43.0],
        [-85.7, 42.3],
        [-83.0, 41.8],
        [-81.0, 41.5],
        [-80.0, 42.1],
        [-78.7, 42.9],
        [-77.6, 43.2],
        [-76.1, 43.0],
        [-75.0, 42.7],
        [-73.8, 42.7],
        [-73.0, 42.4],
        [-71.1, 42.4],
      ],
    },

    // I-70 (Central: Utah to Maryland)
    {
      name: "I-70",
      coords: [
        [-112.0, 38.5],
        [-109.0, 38.8],
        [-107.0, 39.1],
        [-105.0, 39.7],
        [-104.9, 39.7],
        [-102.0, 39.3],
        [-100.0, 39.4],
        [-97.0, 39.0],
        [-95.2, 39.1],
        [-94.6, 39.1],
        [-93.0, 38.9],
        [-91.2, 38.8],
        [-90.2, 38.6],
        [-89.0, 38.6],
        [-87.5, 39.8],
        [-86.1, 39.8],
        [-85.0, 39.8],
        [-84.5, 39.1],
        [-83.0, 40.0],
        [-81.5, 40.1],
        [-80.7, 40.0],
        [-79.0, 39.7],
        [-77.7, 39.6],
        [-77.0, 39.3],
      ],
    },

    // I-75 (North-South: Michigan to Florida)
    {
      name: "I-75",
      coords: [
        [-84.4, 46.5],
        [-84.7, 45.0],
        [-84.0, 43.4],
        [-83.7, 43.0],
        [-83.0, 42.3],
        [-84.0, 41.7],
        [-83.6, 41.4],
        [-83.5, 39.1],
        [-84.5, 39.1],
        [-84.4, 38.0],
        [-84.3, 37.0],
        [-84.1, 36.6],
        [-83.9, 36.0],
        [-84.3, 35.0],
        [-84.5, 34.0],
        [-83.8, 33.8],
        [-83.7, 33.0],
        [-83.3, 31.2],
        [-83.0, 30.4],
        [-82.6, 29.7],
        [-82.5, 28.0],
        [-82.4, 27.3],
        [-82.3, 26.1],
      ],
    },

    // I-35 (Central North-South: Minnesota to Texas)
    {
      name: "I-35",
      coords: [
        [-93.3, 46.7],
        [-93.2, 45.0],
        [-93.1, 44.0],
        [-93.2, 43.0],
        [-94.0, 41.6],
        [-93.6, 41.6],
        [-93.6, 40.8],
        [-94.6, 39.1],
        [-94.8, 38.9],
        [-95.2, 38.9],
        [-95.7, 38.0],
        [-96.8, 37.7],
        [-97.3, 37.7],
        [-97.5, 36.2],
        [-97.5, 35.5],
        [-97.5, 34.0],
        [-97.3, 32.8],
        [-97.7, 30.3],
        [-98.5, 29.4],
      ],
    },
  ];

  const features = highways.map((highway) => ({
    type: "Feature",
    properties: {
      name: highway.name,
    },
    geometry: {
      type: "LineString",
      coordinates: highway.coords,
    },
  }));

  return {
    type: "FeatureCollection",
    features: features,
  };
}

export default Map;
