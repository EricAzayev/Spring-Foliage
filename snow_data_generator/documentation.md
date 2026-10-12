Snow depth interpolation pipeline

We use daily station observations and elevate them into continuous regional rasters with regression kriging (RK), constrained to CONUS and rendered over hillshade.

Implementation file:
- snow_data_generator/build_daily_snow_surfaces.py

Method implemented

1. Data pre-processing and filtering
- Parses NOAA station text files in client/public/snow_data (snowdepth_YYYYMMDD06_m.txt).
- Extracts day from DateTime_Report(UTC) and groups records day by day.
- Converts WGS84 station coordinates into US equal-area projection (ESRI:102003, with EPSG:5070 fallback).

2. Elevation-based covariate regression (Regression Kriging)
- Fits linear regression SnowDepth(cm) ~ Elevation(m) from station values for each day.
- Samples the projected DEM grid to form the elevation predictor base map.
- Computes residuals and interpolates them with Ordinary Kriging.
- Final snow surface = regression base + kriged residuals.

3. Grid resolution and US boundary masking
- Reprojects DEM to the same equal-area CRS at configured output resolution (default 5000 m).
- Rasterizes CONUS polygon from client/public/us-states.json.
- Applies strict mask to avoid bleed into oceans/outside CONUS.

4. Temporal looping
- Loops over every distinct report day.
- Generates one daily GeoTIFF snow depth raster per day.

5. Visualization / splat metrics
- Produces hillshade from DEM and overlays daily snow raster with transparency.
- Transparent where snow is negligible (< 2 cm), with opacity ramping up organically.
- Color ramp:
  - #819E8D: trace / shallow
  - #459194: shallow-to-moderate
  - #2F3E8B: moderate-to-heavy
  - #4E1D7D: deepest accumulation

Outputs
- Rasters: snow_data_generator/output/rasters/snowdepth_YYYYMMDD.tif
- Visual overlays: snow_data_generator/output/visualizations/snowdepth_YYYYMMDD_overlay.png
- Frontend tile pyramids: client/public/snow_tiles/YYYYMMDD/{z}/{x}/{y}.png

Run

1. Install dependencies:
	pip install -r snow_data_generator/requirements.txt

2. Execute:
	python3 snow_data_generator/build_daily_snow_surfaces.py

3. Generate frontend tiles from the interpolated rasters:
  python3 snow_data_generator/generate_snow_tiles.py

4. Publish the generated tiles and date manifest to Supabase Storage:
  python3 snow_data_generator/migrate_to_supabase.py

The migration requires `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in
`snow_data_generator/.env` (or the repository root `.env`). It uploads each
date's tiles first and publishes `index.json` last, so the frontend only
advertises dates after their tiles have uploaded successfully. Keep the service
key out of source control.

Optional arguments
- --resolution-m 1000 for 1 km grids.
- --dem /path/to/dem.tif to use a dedicated topographic DEM.
- --station-dir /path/to/snow_files
- --states-geojson /path/to/us-states.json
- --min-zoom / --max-zoom in generate_snow_tiles.py to control tile pyramid depth.

