# Data

## Snow

The snow layer starts with daily snow-depth station reports from NOAA's NOHRSC text feed. The download pattern is documented in [snow_data_extraction/script.ipynb](snow_data_extraction/script.ipynb) and follows this URL shape:

`https://www.nohrsc.noaa.gov/nsa/discussions_text/National/snowdepth/YYYYMM/snowdepth_YYYYMMDD06_m.txt`

In this repository, those raw snapshots are stored in [client/public/snow_data](client/public/snow_data) as files such as `snowdepth_2026022806_m.txt`. Each file is a pipe-delimited station report with latitude, longitude, elevation, report time, and snow depth in centimeters.

From there, [snow_data_extraction/build_daily_snow_surfaces.py](snow_data_extraction/build_daily_snow_surfaces.py) turns the point observations into a continuous daily snow surface:

1. It loads every `snowdepth_*_m.txt` file from [client/public/snow_data](client/public/snow_data).
2. It parses the NOHRSC rows, converts the numeric fields, and groups observations by report day.
3. It reprojects the station points from WGS84 into a CONUS equal-area projection.
4. It uses the raster at [client/public/SpringBloom_30yr.tif](client/public/SpringBloom_30yr.tif) as the elevation grid for the interpolation step.
5. For each day, it fits a linear regression of `snow depth ~ elevation`, then kriges the residuals with Ordinary Kriging.
6. It adds the kriged residual surface back to the elevation-based regression surface, clips negative values to zero, and masks everything outside the CONUS polygon built from [client/public/us-states.json](client/public/us-states.json).
7. It writes one GeoTIFF per day to [snow_data_extraction/output/rasters](snow_data_extraction/output/rasters) and one preview overlay PNG per day to [snow_data_extraction/output/visualizations](snow_data_extraction/output/visualizations).

The frontend does not read the raw text files or GeoTIFFs directly. Instead, [snow_data_extraction/generate_snow_tiles.py](snow_data_extraction/generate_snow_tiles.py) converts each daily GeoTIFF into Web Mercator PNG tiles in [client/public/snow_tiles](client/public/snow_tiles). During that step, depths below 2 cm are made transparent, and the remaining snow is colored with the map's four-stop snow ramp.

At runtime, [client/src/App.jsx](client/src/App.jsx) exposes the list of available snow dates, and [client/src/components/Map.jsx](client/src/components/Map.jsx) turns the selected date into a tile URL of the form `/snow_tiles/YYYYMMDD/{z}/{x}/{y}.png`. MapLibre then renders those raster tiles as the snow overlay.

In short: NOHRSC station text files are pulled into `client/public/snow_data`, interpolated into daily CONUS rasters, tiled into `client/public/snow_tiles`, and then displayed by the client as date-switched raster overlays.