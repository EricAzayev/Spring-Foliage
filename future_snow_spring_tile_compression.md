# Future Snow + Spring Tile Packing

## Goal

Investigate whether spring foliage and snow data can share one tile payload so
the combined map view downloads fewer tile objects and stores fewer objects in
Supabase. This is a future experiment, not a change to the current tile
pipeline.

## Current behavior

- Spring raster tiles are organized by day of year, for example
  `tiles/day_069/{z}/{x}/{y}.png`.
- Snow raster tiles are organized by calendar date,
  `snow_tiles/YYYYMMDD/{z}/{x}/{y}.png`.
- In combined view, the frontend adds separate spring and snow raster
  sources. See [Map.jsx](client/src/components/Map.jsx).
- Snow tile generation colorizes snow depth into RGBA PNGs in
  [generate_snow_tiles.py](snow_data_generator/generate_snow_tiles.py).
- The spring raster pipeline also produces display-oriented tiles. See
  [generate_tiles.py](spring_data_generator/generate_tiles.py).

## Expected savings

For one visible `{z}/{x}/{y}` coordinate in combined view:

| Design | Tile requests | Stored tile objects |
| --- | ---: | ---: |
| Current separate spring and snow layers | 2 | 2 |
| One packed tile for a matched spring/snow date pair | 1 | 1 |

That is a **50% reduction in tile requests and tile-object count for the
combined layer pair**, assuming the same coverage and one-to-one date pairing.
More generally, for `N` visible tile coordinates, the request count falls from
`2N` to `N`.

This does not automatically halve total bandwidth or storage bytes. A packed
tile has to carry both datasets, and its encoded size depends on the data,
quantization, and compression. Combined tiles may also be downloaded when a
visitor only wants one layer. Measure object count, payload bytes, and actual
requests before deciding whether the added complexity is worthwhile.

## Avoid alternating pixels

Interleaving source pixels (for example, snow, foliage, snow, foliage across
the tile) is not a suitable lossless packing scheme. Each layer would lose
spatial samples, producing striping, checkerboard artifacts, or lower
effective resolution.

Instead, pack **data values per pixel** into separate channels of a single
lossless tile. For example:

- One channel stores the spring stage/category.
- Another stores quantized snow depth.
- An additional channel or reserved value represents nodata/validity.

The frontend then applies the existing spring palette and snow color/opacity
ramp from those values. This preserves both layers at full tile resolution,
subject to the chosen value encoding and quantization.

## Rendering and date-pair constraints

The current MapLibre `raster` source treats image pixels as display colors; it
does not expose separate packed channels as independent styled layers. A
prototype would therefore need to fetch each packed tile once, decode its
pixel values, and render the selected spring and snow channels. Likely
approaches include a custom WebGL layer/shader or a dedicated tile decode and
canvas/WebGL pipeline. The rendering choice should be validated against
MapLibre behavior, mobile GPUs, map movement, caching, and current fade/overlay
behavior before production adoption.

The current UI can select spring and snow dates independently in combined
view. A single precomputed packed tile naturally represents a specific pair
of dates, so:

- Pairing matching calendar/day-of-year dates is straightforward but changes
  the current independent-timeline behavior.
- Supporting arbitrary date pairs by pre-generating every combination could
  multiply storage rather than reduce it.
- A better general-purpose design may be to pack compatible time slices
  together in a binary/vector tile or request one packed tile per layer-data
  version, but that needs a separate design and measurement.
- Visitors viewing only spring or only snow may transfer extra unused channel
  data unless requests can select a channel or the compression savings
  outweigh that overhead.

## Suggested experiment

1. Record a baseline for representative dates and viewport positions:
   number of requests, total transferred bytes, number of stored objects, and
   decode/render time.
2. Choose a small sample with matching spring and snow dates and identical
   zoom/coverage.
3. Generate a lossless packed tile with documented channel meanings,
   quantization, nodata encoding, and version metadata.
4. Build a minimal client prototype that fetches the packed tile once and
   renders either or both channels.
5. Compare pixel output against the current separate layers and measure
   requests, storage bytes, network bytes, and rendering cost on desktop and
   mobile.
6. Keep the existing independent-date UI unless the packed format is shown to
   support it without date-combination storage growth.
7. Adopt the approach only if measured request/storage benefits justify the
   format, renderer, and operational complexity.

## Branch setup

Create an isolated branch after the snow-data work is merged and the worktree
is clean. These commands intentionally do not switch branches or run
automatically:

```sh
git switch main
git pull --ff-only
git switch -c experiment/packed-snow-spring-tiles
```

If the intended base is not `main`, switch to the desired base branch before
creating the experiment branch.
