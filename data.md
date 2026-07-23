# Data

## Snow

The snow layer starts with daily snow-depth station reports from NOAA's NOHRSC text feed. The download pattern is documented in [snow_data_extraction/script.ipynb](snow_data_extraction/script.ipynb) and follows this URL shape:

`https://www.nohrsc.noaa.gov/nsa/discussions_text/National/snowdepth/YYYYMM/snowdepth_YYYYMMDD06_m.txt`

In this repository, those raw snapshots are stored in [client/public/snow_data](client/public/snow_data) as files such as `snowdepth_2026022806_m.txt`. Each file is a pipe-delimited station report with latitude, longitude, elevation, report time, and snow depth in centimeters.

### How the folders connect

These four folders represent a one-way pipeline. Each stage exists for a different consumer:

1. [client/public/snow_data](client/public/snow_data)
This is the raw input layer. It contains downloaded NOHRSC station snapshots. These files are not derived from anything else in the repo; they are pulled from NOAA and act as the source data for all later snow products.

2. [snow_data_extraction/output/rasters](snow_data_extraction/output/rasters)
This is the analytic output layer. It contains one interpolated GeoTIFF per day, such as `snowdepth_20260310.tif`. These rasters are derived from `snow_data` by parsing the station observations, fitting the elevation regression, kriging the residuals, and masking to CONUS. This is the main machine-readable snow surface product.

3. [snow_data_extraction/output/visualizations](snow_data_extraction/output/visualizations)
This is the preview layer. It contains PNG overlays such as `snowdepth_20260310_overlay.png`. These files are derived from the daily rasters, not directly from `snow_data`. Their purpose is inspection and QA: they let you quickly look at the interpolated surface over hillshade without needing GIS tooling.

4. [client/public/snow_tiles](client/public/snow_tiles)
This is the web-delivery layer. It contains tiled PNG pyramids and an `index.json` manifest for the frontend. These files are also derived from the daily rasters, not directly from `snow_data`. Their purpose is browser rendering: MapLibre can stream small Web Mercator tiles efficiently, but it cannot use the full daily analysis GeoTIFFs directly as a production map source.

So the derivation graph is:

`NOHRSC feed -> snow_data -> rasters -> visualizations`

and separately:

`NOHRSC feed -> snow_data -> rasters -> snow_tiles -> browser map`

From there, [snow_data_extraction/build_daily_snow_surfaces.py](snow_data_extraction/build_daily_snow_surfaces.py) turns the point observations into a continuous daily snow surface:

1. It loads every `snowdepth_*_m.txt` file from [client/public/snow_data](client/public/snow_data).
2. It parses the NOHRSC rows, converts the numeric fields, and groups observations by report day.
3. It reprojects the station points from WGS84 into a CONUS equal-area projection.
4. It uses the raster at [client/public/SpringBloom_30yr.tif](client/public/SpringBloom_30yr.tif) as the elevation grid for the interpolation step.
5. For each day, it fits a linear regression of `snow depth ~ elevation`, then kriges the residuals with Ordinary Kriging.
6. It adds the kriged residual surface back to the elevation-based regression surface, clips negative values to zero, and masks everything outside the CONUS polygon built from [client/public/us-states.json](client/public/us-states.json).
7. It writes one GeoTIFF per day to [snow_data_extraction/output/rasters](snow_data_extraction/output/rasters) and one preview overlay PNG per day to [snow_data_extraction/output/visualizations](snow_data_extraction/output/visualizations).

The frontend does not read the raw text files or GeoTIFFs directly. Instead, [snow_data_extraction/generate_snow_tiles.py](snow_data_extraction/generate_snow_tiles.py) converts each daily GeoTIFF into Web Mercator PNG tiles in [client/public/snow_tiles](client/public/snow_tiles). During that step, depths below 2 cm are made transparent, and the remaining snow is colored with the map's four-stop snow ramp. The same step now also writes [client/public/snow_tiles/index.json](client/public/snow_tiles/index.json), which lists the dates and zoom levels that actually exist on disk.

At runtime, [client/src/App.jsx](client/src/App.jsx) exposes the list of available snow dates, and [client/src/components/Map.jsx](client/src/components/Map.jsx) turns the selected date into a tile URL of the form `/snow_tiles/YYYYMMDD/{z}/{x}/{y}.png`. MapLibre plots the snow surface as a raster tile source layered on top of the terrain fill and hillshade, so what you see is the pre-rendered PNG tile pyramid rather than live kriging in the browser.

The decode error happened because the map was trying to plot snow tiles that had not been generated yet. When `/snow_tiles/YYYYMMDD/{z}/{x}/{y}.png` does not exist, the dev server returns a non-image response, and MapLibre still attempts to decode it as a PNG. That is what triggers `InvalidStateError: The source image could not be decoded.` The client now checks the snow tile manifest before adding the raster source, so missing snow tiles fail closed instead of spamming image decode errors.

In short: `snow_data` is the raw NOAA input, `rasters` is the derived analysis product, `visualizations` is the derived QA/preview product, and `snow_tiles` is the derived frontend delivery product.