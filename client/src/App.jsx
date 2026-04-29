import { useState, useEffect, useRef } from "react";
import Map from "./components/Map";
import "./App.css";
import { supabase } from "./utils/supabase";

// Unique ID for this page load — shared across StrictMode remounts (module runs once per load)
const VISIT_ID = crypto.randomUUID();

function App() {
  const [currentDate, setCurrentDate] = useState(new Date(2025, 1, 23)); // February 23, 2025
  const visitStart = useRef(Date.now());

  useEffect(() => {
    // Guard against StrictMode's double-mount firing two inserts
    if (sessionStorage.getItem(VISIT_ID)) return;
    sessionStorage.setItem(VISIT_ID, "1");

    const rowId = { current: null };

    // Step 1: INSERT a view row on mount — visit_id ensures DB-level deduplication on retries
    supabase
      .from("Views")
      .insert({ project: "Spring Foliage Map", page: "Home", views: 1, visit_id: VISIT_ID })
      .select("id")
      .single()
      .then(({ data, error }) => {
        if (error) { console.error("View tracking error:", error.message); return; }
        rowId.current = data.id;
      });

    // Step 2: PATCH time_on_page when the user leaves
    // fetch with keepalive:true completes even as the page unloads
    const handleUnload = () => {
      if (!rowId.current) return;
      const seconds = Math.round((Date.now() - visitStart.current) / 1000);
      const baseUrl = (import.meta.env.VITE_SUPABASE_URL || "")
        .replace(/\/rest\/v1\/?$/, "")
        .replace(/\/$/, "");
      fetch(
        `${baseUrl}/rest/v1/Views?id=eq.${rowId.current}`,
        {
          method: "PATCH",
          keepalive: true,
          headers: {
            "Content-Type": "application/json",
            "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ time_on_page: seconds }),
        }
      );
    };

    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, []);
  const [dayOfYear, setDayOfYear] = useState(54); // Day 54 = February 23

  const colorLegend = [
    { color: "#4a3728", label: "None" },
    { color: "#8b7355", label: "Budding" },
    { color: "#d4e157", label: "First Leaf" },
    { color: "#e91e63", label: "Bloom" },
    { color: "#9c27b0", label: "Peak Bloom" },
    { color: "#4caf50", label: "Canopy" },
    { color: "#1b5e20", label: "Post" },
  ];

  const handleSliderChange = (e) => {
    const day = parseInt(e.target.value);
    setDayOfYear(day);
    // Convert day of year to date
    const date = new Date(2025, 0, day);
    setCurrentDate(date);
  };

  const formatDate = (date) => {
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <h1>Spring Foliage Map 2025</h1>
        <p className="tagline">Watch spring unfold across the U.S.</p>
      </header>

      {/* Color Legend */}
      <div className="legend-container">
        <div className="legend">
          {colorLegend.map((item, index) => (
            <div key={index} className="legend-item">
              <div
                className="legend-swatch"
                style={{ backgroundColor: item.color }}
              />
              <span className="legend-label">{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Map Placeholder (Purple Square) */}
      <div className="map-wrapper">
        <Map dayOfYear={dayOfYear} />
      </div>

      {/* Date Display & Slider */}
      <div className="slider-container">
        <div className="date-display">
          {formatDate(currentDate)}{" "}
          <span className="day-label">(Day {dayOfYear})</span>
        </div>
        <input
          type="range"
          min="54"
          max="180"
          value={dayOfYear}
          onChange={handleSliderChange}
          className="date-slider"
        />
        <div className="slider-labels">
          <span>February 23</span>
          <span>June 29</span>
        </div>
      </div>

      {/* Article Section */}
      <article className="article-section">
        <h2>About Spring</h2>
        <div className="article-content">
          <p>
            Spring is a season of change, when the world wakes from winter's
            peaceful somber. Across the United States, trees flex new leaves,
            flowers burst into color, and landscapes slowly turn from damp
            browns to vibrant greens, pinks, yellows, and purples. For hikers
            deep in forest trails, spring offers a richness of fresh scents,
            bright blossoms, and the rustle of life returning to the canopy. For
            casual observers, it's a reminder that new starts can be beautiful.
            For farmers, gardeners, and scientists, spring marks the beginning
            of a growth cycle that will shape crops, ecosystems, and wildlife
            patterns for the year. This map serves as your guide to following
            nature's heartbeat, displaying the flow of spring across regions in
            real-time. Whether you're planning a weekend hike or chasing blooms
            for selfies, the unfolding of spring is here for everyone.
          </p>

          <h3>The Science of Bloom</h3>
          <p>
            Why do trees bud at certain times, and flowers bloom synchronously
            across regions? It's all a chaotic design influenced by temperature
            and sunlight. Plants contain pigments like chlorophyll, which drive
            photosynthesis, and anthocyanins, which give reds and purples to
            some leaves and flowers. As winter gives way to spring thaw,
            increasing daylight and warmer temperatures trigger hormonal changes
            in plants, prompting buds to swell and blossoms to cover branches.
            Some species bloom earlier, while others wait for a more stable
            climate. Thus, a magnolia in Georgia may flower weeks before a
            cherry tree in Washington. Climate, altitude, and local weather
            patterns all play a role, making spring a patchwork of timing across
            the country. Understanding these patterns helps ecologists track
            changes in climate, farmers predict harvest times, and nature
            enthusiasts know when to expect peak beauty in their favorite spots.
          </p>

          <h3>What Each Color Means</h3>
          <p>
            This map uses simple color codes to track the progress of Spring:
          </p>
          <ul className="color-meanings">
            <li>
              <strong>None (Dark Brown):</strong> The season hasn't quite begun
              here. Trees and plants remain dormant, quietly preparing for the
              growth to come.
            </li>
            <li>
              <strong>Budding (Light Brown):</strong> Tiny buds appear on
              branches, teasing that change is near.
            </li>
            <li>
              <strong>First Leaf (Yellowish Green):</strong> Leaves begin to
              unfurl, adding the first shades of green to the landscape.
            </li>
            <li>
              <strong>First Bloom (Purplish Pink):</strong> Flowers are
              beginning their departure, turning parks and backyards into
              colorful displays.
            </li>
            <li>
              <strong>Peak Bloom (Purple):</strong> Spring is in full swing.
              Trees and flowers are vibrant, lush, and alive with activity. Make
              sure to visit your local gardens!
            </li>
            <li>
              <strong>Canopy Greening (Naturally Green):</strong> Leaves
              dominate the view, creating a continuous green canopy. This stage
              signals the completion of most leaf-out.
            </li>
            <li>
              <strong>Post Bloom (Dark Green):</strong> Flowers fade, but the
              leaves remain. Nature transitions from spectacle to stable growth,
              preparing for summer.
            </li>
          </ul>
          <p>
            Each color tells a story of life waking up, so whether you're
            watching your local park, planning a road trip, or studying seasonal
            patterns, you can watch spring as it moves across the United States.
          </p>
        </div>
      </article>
    </div>
  );
}

export default App;
