import { useState } from "react";
import Map from "./components/Map";
import "./App.css";

const AVAILABLE_SNOW_DATES = [
  new Date(2026, 1, 23),
  new Date(2026, 1, 24),
  new Date(2026, 1, 25),
  new Date(2026, 1, 26),
  new Date(2026, 1, 27),
  new Date(2026, 1, 28),
  new Date(2026, 2, 1),
];

const getDayOfYear = (date) => {
  const startOfYear = new Date(date.getFullYear(), 0, 0);
  const diff = date - startOfYear;
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
};

function App() {
  const [sliderIndex, setSliderIndex] = useState(0);
  const [viewMode, setViewMode] = useState("snow");
  const currentDate = AVAILABLE_SNOW_DATES[sliderIndex];
  const dayOfYear = getDayOfYear(currentDate);

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
    setSliderIndex(parseInt(e.target.value, 10));
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
        <h1>Spring Foliage Map 2026</h1>
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
        <div className="view-mode-controls" aria-label="Map overlay mode">
          {[
            { id: "spring", label: "Spring" },
            { id: "snow", label: "Snow" },
            { id: "combined", label: "Spring and Snow" },
          ].map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`view-mode-button ${viewMode === id ? "active" : ""}`}
              onClick={() => setViewMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <Map dayOfYear={dayOfYear} viewMode={viewMode} snowDate={currentDate} />
      </div>

      {/* Date Display & Slider */}
      <div className="slider-container">
        <div className="date-display">
          {formatDate(currentDate)}{" "}
          <span className="day-label">(Day {dayOfYear})</span>
        </div>
        <input
          type="range"
          min="0"
          max={String(AVAILABLE_SNOW_DATES.length - 1)}
          value={sliderIndex}
          onChange={handleSliderChange}
          className="date-slider"
        />
        <div className="slider-labels">
          <span>February 23</span>
          <span>March 1</span>
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
