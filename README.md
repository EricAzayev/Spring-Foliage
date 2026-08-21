# 🌸 Spring Foliage Map

> **Interactive visualization of spring bloom progression across the United States**

An interactive web map that tracks and visualizes the progression of spring foliage across the continental US. Watch as spring sweeps from south to north, transforming the landscape from budding branches to full bloom canopy—all controlled by a simple date slider.

**[🔗 Live Demo](https://springfoliagemap.vercel.app/)** • **[📹 Watch Demo Video](https://youtu.be/)**

---

## ✨ Features

- **📅 Time-slider Navigation** – Scrub through spring from February to June, day by day
- **🗺️ Three Rendering Modes** – Choose between pre-rendered tiles (fast), CPU mode (dynamic), or GPU mode (WebGL accelerated)
- **🏔️ 3D Terrain View** – Toggle between flat 2D and immersive 3D hillshaded terrain
- **🎨 7-Stage Color Coding** – Visualize bloom progression from dormant to post-bloom
- **📊 Based on 30-Year Climate Data** – Historical bloom day predictions from NOAA/USGS

---

## 🚀 Tech Stack

**Frontend**
- React 19 + Vite
- MapLibre GL JS (terrain + vector rendering)
- WebGL (custom shader-based tile generation)
- GeoTIFF.js (climate data parsing)
- Turf.js (geospatial processing)

**Data Pipeline**
- Python + NumPy (tile pre-generation)
- Supabase (tile storage + analytics)

**Deployment**
- Vercel (production hosting)
- GitHub Actions (CI/CD)

---

## 📊 How It Works

The map uses 30-year average first bloom dates from climate models to predict spring phenology. Each pixel represents a geographic location with its historical "first bloom day" (day of year 1-365).

### Bloom Stage Formula

| Stage          | Timeline                     | Color      |
|----------------|------------------------------|------------|
| None           | > 15 days before bloom       | Dark brown |
| Budding        | 10-15 days before            | Tan        |
| First Leaf     | 5-10 days before             | Yellow-green |
| **Bloom**      | **Day of first bloom**       | **Pink**   |
| Peak Bloom     | 3 days after                 | Purple     |
| Canopy         | 10 days after                | Bright green |
| Post-Bloom     | 20+ days after               | Forest green |

---

## 🎮 Quick Start

### Prerequisites
- Node.js 16+ and npm

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/Spring-Foliage.git
cd Spring-Foliage/client

# Install dependencies
npm install

# Start development server
npm run dev
```

Visit `http://localhost:5173` to see the map in action.

### Building for Production

```bash
npm run build
npm run preview  # Preview production build locally
```

---

## 🛠️ Project Structure

```
Spring-Foliage/
├── client/                   # React frontend
│   ├── src/
│   │   ├── components/       # Map component + UI
│   │   ├── utils/            # WebGL processors, Supabase client
│   │   └── App.jsx           # Main app + analytics
│   └── public/
│       ├── SpringBloom_30yr.tif  # Climate data (GeoTIFF)
│       └── tiles/            # Pre-rendered raster tiles
├── data_generator/           # Python tile generation scripts
└── README.md
```

---

## 🎯 Why This Project?

While fall foliage trackers are common (see [SmokyMountains.com](https://smokymountains.com/fall-foliage-map/)), **no equivalent exists for spring**. This project fills that gap, providing value for:

- 🌻 **Nature enthusiasts** planning spring road trips
- 🔬 **Researchers** studying climate patterns and phenology shifts
- 📸 **Photographers** timing peak bloom for different regions
- 🎓 **Educators** teaching geography and seasonal changes

---

## 📈 Performance Optimizations

- **Raster Mode (default)**: Pre-rendered PNG tiles stored on CDN → instant load times
- **GPU Mode**: WebGL fragment shaders sample GeoTIFF in real-time → dynamic rendering without server calls
- **CPU Mode**: Client-side GeoJSON grid generation → full control over rendering logic
- **Tile Caching**: LRU cache for GPU-generated tiles reduces redundant computation
- **Lazy Loading**: GeoTIFF data only loads when switching to CPU/GPU modes

---

## 🤝 Contributing

Contributions welcome! Areas for improvement:
- Additional climate data sources (soil temperature, precipitation)
- Mobile UX enhancements
- Export functionality (save maps as images)
- Multi-year comparison mode

---

## 📝 License

MIT License - feel free to use this code for your own projects.

---

## 🙏 Acknowledgments

- Climate data: NOAA National Phenology Network
- Terrain tiles: AWS Terrarium (USGS SRTM)
- State boundaries: Natural Earth Data

