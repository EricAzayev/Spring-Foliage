# Map Documentation

## Overview
The Spring Foliage Map is an interactive 3D visualization that displays the progression of spring across the continental United States. It uses MapLibre GL JS to render terrain, state boundaries, highways, and dynamically colored foliage overlays that change based on the day of the year.

## Technology Stack
- **Mapping Library**: MapLibre GL JS v5.14.0
- **Framework**: React 19.2.0
- **Build Tool**: Vite
- **CSS**: Custom styling with responsive design

## File Locations
```
client/
├── src/
│   ├── App.jsx                 # Main application with date slider
│   ├── App.css                 # App styling
│   ├── components/
│   │   ├── Map.jsx             # Core map component (684 lines)
│   │   └── Map.css             # Map styling
│   ├── main.jsx                # React entry point
│   └── index.css               # Global styles
├── package.json                # Dependencies
└── vite.config.js              # Build configuration
```

## Map Configuration

### Initial View Settings
The map initializes centered on the United States with these parameters:
- **Center Coordinates**: `[-98.5, 39.8]` (geographic center of US)
- **Zoom Level**: `3.5` (continental view)
- **Pitch**: `0` degrees (top-down by default)
- **Bearing**: `0` degrees (north-up orientation)
- **Interactive**: `true` (allows panning and zooming)

### Boundary Constraints
The map is restricted to continental US using `maxBounds`:
- **Southwest Corner**: `[-130, 24]`
- **Northeast Corner**: `[-65, 50]`

This prevents users from navigating to other countries or non-continental US territories (Alaska and Hawaii are explicitly excluded from the data).

## Data Sources

### 1. Base Map Style
- **Source**: `https://demotiles.maplibre.org/style.json`
- **Purpose**: Provides the foundational map style
- **Note**: All default layers are hidden to create a clean canvas

### 2. US State Boundaries
- **Source**: `https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json`
- **Format**: GeoJSON
- **Processing**: 
  - Fetched on map load
  - Filtered to exclude Alaska and Hawaii
  - Used as the base for the foliage overlay
- **Rendering**: 
  - Light tan/beige fill (`#E8DCC8`)
  - Light gray borders (`#E4E4E4`, 0.7px width)

### 3. Terrain Data
- **Source**: `https://demotiles.maplibre.org/terrain-tiles/tiles.json`
- **Type**: Raster DEM (Digital Elevation Model)
- **Tile Size**: 256px
- **Exaggeration**: 1.5x (makes elevation more dramatic)

### 4. Hillshade
- **Source**: `https://tile.openstreetmap.fr/hillshading/{z}/{x}/{y}.png`
- **Type**: Raster tiles
- **Opacity**: 0.5
- **Brightness**: Min 0.3, Max 1.0
- **Purpose**: Adds visual depth and topographic detail

### 5. Highway Data
- **Source**: Hardcoded in `createMajorHighways()` function
- **Highways Included**: I-5, I-10, I-40, I-70, I-75, I-80, I-90, I-95, I-35
- **Format**: GeoJSON LineStrings with coordinate arrays
- **Styling**: Gray lines (`#B6B6B6`), width interpolates from 0.8px (zoom 3) to 2.5px (zoom 9), 60% opacity

## Map Layers (Render Order)

The layers are stacked in this order (bottom to top):

1. **ocean-background** - Background layer, light blue (`#D4E7F5`)
2. **hillshade** - Raster hillshading for terrain texture
3. **terrain-hillshade** - Hillshade effect from terrain DEM
4. **us-terrain** - Base US state fill (light tan)
5. **foliage-fill** - Dynamic foliage color overlay
6. **state-borders-line** - State boundary lines
7. **highways-line** - Interstate highway lines

## Foliage Visualization

### Color Scheme
The foliage progresses through seven stages with distinct colors:

| Stage | Color Code | Description |
|-------|-----------|-------------|
| **none** | `#4B3621` | Dark brown - dormant/winter state |
| **budding** | `#A67B5B` | Light brown - early buds forming |
| **firstLeaf** | `#ADFF2F` | Yellow-green - first leaves emerging |
| **firstBloom** | `#DA70D6` | Orchid - initial flowering |
| **peakBloom** | `#800080` | Purple - peak flowering period |
| **canopy** | `#228B22` | Forest green - full leaf canopy |
| **postBloom** | `#006400` | Dark green - mature summer foliage |

### Spring Timing Calculation

Each US state is assigned a `spring_day` value based on its center latitude:

**Formula**: `spring_day = 60 + ((centerLat - 25) / 25) * 60`

**Examples**:
- Florida (lat ~28): spring_day ≈ 67 (early March)
- Texas (lat ~31): spring_day ≈ 74 (mid-March)
- California (lat ~36.8): spring_day ≈ 88 (late March)
- Colorado (lat ~39): spring_day ≈ 94 (early April)
- New York (lat ~43): spring_day ≈ 103 (mid-April)
- Minnesota (lat ~46): spring_day ≈ 110 (late April)

**Range**: Clamped between day 60 (March 1) and day 140 (May 20)

This creates a realistic north-to-south gradient where southern states experience spring earlier than northern states.

### Dynamic Color Interpolation

The foliage color updates in real-time based on the `dayOfYear` prop passed from the parent component. The interpolation expression works as follows:

```javascript
[
  "interpolate",
  ["linear"],
  ["get", "spring_day"],
  0,                    foliageColors.none,
  dayOfYear - 30,       foliageColors.none,
  dayOfYear - 20,       foliageColors.budding,
  dayOfYear - 10,       foliageColors.firstLeaf,
  dayOfYear,            foliageColors.firstBloom,
  dayOfYear + 10,       foliageColors.peakBloom,
  dayOfYear + 20,       foliageColors.canopy,
  dayOfYear + 30,       foliageColors.postBloom,
  200,                  foliageColors.postBloom,
]
```

**How it works**:
- Each state's `spring_day` property is compared against the current `dayOfYear`
- States where `spring_day` is 30 days before current day: still dormant (none)
- States at their `spring_day`: experiencing first blooms
- States 30+ days past their `spring_day`: full summer canopy
- Creates a smooth gradient effect as spring "moves" across the map

## 3D View Toggle

### Toggle Button
- **Location**: Top-right corner of map (absolute positioning)
- **Styling**: Cream background (`#faf8f0`), dark border, hover effect turns olive green (`#556b2f`)
- **Icons**: Different SVG icons for 2D (rectangle) and 3D (isometric cube) modes
- **Responsive**: Text label hidden on mobile (<768px width)

### View States

**2D View (Default)**:
- Pitch: 0° (straight down)
- Bearing: 0° (north-up)

**3D View**:
- Pitch: 60° (angled side view)
- Bearing: 0° (north-up)
- Transition: Smooth 1000ms animation

The 3D terrain uses the DEM data with 1.5x exaggeration to make elevation changes more visible.

## Parent Component Integration

### App.jsx Connection
The Map component receives the `dayOfYear` prop from App.jsx:

```jsx
<Map dayOfYear={dayOfYear} />
```

### Date Slider Control
- **Range**: Day 60 (March 1) to Day 180 (June 29)
- **Default**: Day 102 (April 12, 2025)
- Updates map colors in real-time as user slides

### Color Legend
The App displays a legend with the seven foliage stages, allowing users to understand the color coding.

## State Management

### React Hooks Used
- `useRef`: Maintains references to map container and map instance
- `useState`: Tracks 3D view toggle state
- `useEffect`: Two effects:
  1. Map initialization (runs once)
  2. Foliage color updates (runs when dayOfYear changes)

### Cleanup
On component unmount, the map instance is properly destroyed:
```javascript
map.current.remove();
map.current = null;
```

## Performance Considerations

1. **Single Initialization**: Map initializes only once, preventing memory leaks
2. **Conditional Updates**: Foliage colors only update when `dayOfYear` changes and map is loaded
3. **GeoJSON Caching**: State boundaries and highways are loaded once and reused
4. **Tile Caching**: MapLibre automatically caches map tiles
5. **Layer Visibility**: Base map layers are hidden to reduce rendering overhead

## Error Handling

- State border fetch errors are logged but don't crash the app
- Paint property updates are wrapped in try-catch blocks
- Layer visibility changes handle exceptions for incompatible layers

## Responsive Design

### Desktop
- Map height: 600px
- Full button text visible
- Standard padding and sizing

### Mobile (<768px)
- Map height: 400px
- Button text hidden (icon only)
- Reduced padding and font sizes
- Touch-friendly controls

## How the Map Works (Step-by-Step)

1. **Initialization**: Component mounts and creates MapLibre instance with US center point
2. **Base Setup**: Ocean background and hidden default layers create clean canvas
3. **Terrain Loading**: DEM data loads and terrain exaggeration is applied
4. **Visual Effects**: Hillshading and hillshade layers add topographic depth
5. **Data Fetch**: US states GeoJSON is fetched from GitHub
6. **Foliage Creation**: Each state gets a `spring_day` value based on latitude
7. **Highway Generation**: Major interstates are created from hardcoded coordinates
8. **Layer Rendering**: All layers are added in correct order
9. **Interactive Updates**: When user moves slider, `dayOfYear` changes
10. **Color Recalculation**: Foliage layer colors update based on interpolation formula
11. **View Toggle**: User can switch between 2D and 3D views with smooth animation

## Future Enhancement Possibilities

- Real phenology data from USGS or NASA
- County-level granularity instead of state-level
- Additional vegetation types (deciduous vs evergreen)
- Historical year comparison
- Climate zone overlays
- Animated auto-play mode
- More detailed highway networks
- City/landmark labels
- Weather pattern overlays

## Key Functions

### `createFoliageFromStates(statesGeoJSON)`
- Takes US states GeoJSON as input
- Filters out Alaska and Hawaii
- Calculates `spring_day` for each state based on latitude
- Returns modified GeoJSON with spring timing properties

### `createMajorHighways()`
- Returns hardcoded GeoJSON of 9 major interstate highways
- Each highway is a LineString with coordinate array
- Covers major east-west and north-south routes across US

### `toggle3DView()`
- Toggles boolean state
- Animates map pitch between 0° (2D) and 60° (3D)
- Updates button icon and label

## Summary for AI
This map component uses MapLibre GL JS to render a dynamic, 3D visualization of spring foliage progression across the continental US. It fetches US state boundaries from GitHub, calculates spring timing based on latitude (south = earlier, north = later), and interpolates seven foliage color stages based on a user-controlled day-of-year slider. The map includes terrain elevation, hillshading, state borders, and major highways. Users can toggle between top-down and 3D side views. All data sources are external URLs except highways, which are hardcoded. The component is fully self-contained with proper lifecycle management and error handling.
