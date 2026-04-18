/**
 * GPU-Accelerated Raster Tile Generator
 * 
 * Generates map tiles on-the-fly using WebGL to sample GeoTIFF data
 * and render them as colored raster images. Uses zoom level 4 only.
 */

const TILE_SIZE = 256; // Standard web tile size

// Helper function to get geographic bounds of a tile
const tileBounds = (x, y, z) => {
  const n = Math.pow(2, z);
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const south = Math.atan(Math.sinh(-Math.PI * (2 * (y + 1) / n - 1))) * 180 / Math.PI;
  const north = Math.atan(Math.sinh(-Math.PI * (2 * y / n - 1))) * 180 / Math.PI;
  return { west, east, south, north };
};

const VERTEX_SHADER = `#version 100
precision highp float;

attribute vec2 position;

varying vec2 vTexCoord;

void main() {
  vTexCoord = position * 0.5 + 0.5; // Convert [-1,1] to [0,1]
  gl_Position = vec4(position, 0.0, 1.0);
}`
;

const FRAGMENT_SHADER = `#version 100
precision highp float;

uniform sampler2D rasterTexture;
uniform vec4 bbox;              // [west, south, east, north] of GeoTIFF
uniform vec2 rasterSize;        // [width, height] of GeoTIFF in pixels
uniform vec4 tileBbox;          // [west, south, east, north] of tile
uniform float dayOfYear;        // Current day of year from slider

varying vec2 vTexCoord;

// Color based on days difference (current day - bloom day)
// Matches CPU mode logic with smooth interpolation between stages
vec3 daysDiffToColor(float diff) {
  vec3 postBloom  = vec3(0.0,   100.0,  0.0)   / 255.0;
  vec3 canopy     = vec3(173.0, 255.0,  47.0)  / 255.0;
  vec3 peakBloom  = vec3(128.0, 0.0,    128.0) / 255.0;
  vec3 firstBloom = vec3(218.0, 112.0,  214.0) / 255.0;
  vec3 firstLeaf  = vec3(201.0, 217.0,  111.0) / 255.0;
  vec3 budding    = vec3(166.0, 123.0,  91.0)  / 255.0;
  vec3 none       = vec3(75.0,  54.0,   33.0)  / 255.0;

  if (diff >= 20.0) {
    return postBloom;
  } else if (diff >= 10.0) {
    return mix(canopy, postBloom, (diff - 10.0) / 10.0);
  } else if (diff >= 3.0) {
    return mix(peakBloom, canopy, (diff - 3.0) / 7.0);
  } else if (diff >= -5.0) {
    return mix(firstBloom, peakBloom, (diff + 5.0) / 8.0);
  } else if (diff >= -10.0) {
    return mix(firstLeaf, firstBloom, (diff + 10.0) / 5.0);
  } else if (diff >= -15.0) {
    return mix(budding, firstLeaf, (diff + 15.0) / 5.0);
  } else {
    return mix(none, budding, clamp((diff + 25.0) / 10.0, 0.0, 1.0));
  }
}

void main() {
  // Convert tile pixel coordinates to geographic coordinates
  float lon = tileBbox.x + vTexCoord.x * (tileBbox.z - tileBbox.x);
  // FIX: vTexCoord.y goes 0 (bottom) to 1 (top), should map to south→north
  float lat = tileBbox.y + vTexCoord.y * (tileBbox.w - tileBbox.y);
  
  // Clamp to GeoTIFF bounds (handles edge cases)
  lon = clamp(lon, bbox.x, bbox.z);
  lat = clamp(lat, bbox.y, bbox.w);
  
  // Convert geographic coordinates to raster texture coordinates [0, 1]
  float xRatio = (lon - bbox.x) / (bbox.z - bbox.x);
  // GeoTIFF stored north-to-south: row 0 = north, row height-1 = south
  // So north latitude should sample from v=0, south from v=1
  float yRatio = (bbox.w - lat) / (bbox.w - bbox.y);
  
  // Sample the GeoTIFF texture
  vec2 rasterCoord = vec2(xRatio, yRatio);
  float encoded = texture2D(rasterTexture, rasterCoord).r * 255.0;
  
  // 0 = no data (ocean, outside US, etc.) — render transparent
  if (encoded < 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  
  // Decode back to bloom day (1-365)
  float bloomDay = ((encoded - 1.0) / 254.0) * 365.0;

  // Compute days difference and color exactly like CPU mode
  float diff = dayOfYear - bloomDay;
  vec3 color = daysDiffToColor(diff);
  gl_FragColor = vec4(color, 1.0);
}
`;

class RasterTileProcessor {
  constructor() {
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.geoTiffTexture = null;
    this.framebuffer = null;
    this.colorTexture = null;
    this.geoTiffData = null;
    this.tileCache = new Map(); // Cache rendered tiles
    this.initialized = false;
  }

  async init() {
    try {
      this.canvas = document.createElement("canvas");
      this.canvas.width = TILE_SIZE;
      this.canvas.height = TILE_SIZE;

      this.gl = this.canvas.getContext("webgl", {
        preserveDrawingBuffer: true,
        antialias: false,
      });

      if (!this.gl) {
        console.warn("WebGL not supported");
        return false;
      }

      // Compile shaders
      const vs = this.compileShader(this.gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = this.compileShader(this.gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

      if (!vs || !fs) return false;

      // Link program
      this.program = this.gl.createProgram();
      this.gl.attachShader(this.program, vs);
      this.gl.attachShader(this.program, fs);
      this.gl.linkProgram(this.program);

      if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
        console.error("Program link error:", this.gl.getProgramInfoLog(this.program));
        return false;
      }

      this.gl.useProgram(this.program);

      // Set up framebuffer for tile rendering
      this.colorTexture = this.gl.createTexture();
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.colorTexture);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RGBA,
        TILE_SIZE,
        TILE_SIZE,
        0,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        null
      );

      this.framebuffer = this.gl.createFramebuffer();
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
      this.gl.framebufferTexture2D(
        this.gl.FRAMEBUFFER,
        this.gl.COLOR_ATTACHMENT0,
        this.gl.TEXTURE_2D,
        this.colorTexture,
        0
      );

      if (
        this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) !==
        this.gl.FRAMEBUFFER_COMPLETE
      ) {
        console.warn("Framebuffer incomplete");
        return false;
      }

      // Set up full-screen quad
      const posBuffer = this.gl.createBuffer();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, posBuffer);
      const positions = [-1, -1, 1, -1, -1, 1, 1, 1];
      this.gl.bufferData(
        this.gl.ARRAY_BUFFER,
        new Float32Array(positions),
        this.gl.STATIC_DRAW
      );

      const posLocation = this.gl.getAttribLocation(this.program, "position");
      this.gl.enableVertexAttribArray(posLocation);
      this.gl.vertexAttribPointer(posLocation, 2, this.gl.FLOAT, false, 0, 0);

      this.gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
      this.gl.clearColor(0, 0, 0, 0);

      this.initialized = true;
      console.log("Raster tile processor initialized");
      return true;
    } catch (e) {
      console.error("Raster tile processor init failed:", e);
      return false;
    }
  }

  compileShader(type, source) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error(
        "Shader error:",
        this.gl.getShaderInfoLog(shader)
      );
      return null;
    }
    return shader;
  }

  /**
   * Load GeoTIFF data for sampling
   */
  loadGeoTIFF(geoTiffData) {
    this.geoTiffData = geoTiffData;
    const { rasterData, width, height } = geoTiffData;

    // Check if raster has data
    let minVal = 365, maxVal = 0, count = 0;
    for (let i = 0; i < rasterData.length; i++) {
      if (rasterData[i] > 0) {
        minVal = Math.min(minVal, rasterData[i]);
        maxVal = Math.max(maxVal, rasterData[i]);
        count++;
      }
    }
    console.log(`[GPU] GeoTIFF loaded: ${width}x${height}, ${count} non-zero values, range [${minVal}, ${maxVal}]`);

    // Encode raw bloom day into texture: 0 = no data, 1-255 = day mapped across 1-365
    // This preserves the ability to detect invalid/ocean pixels in the shader
    const rgbaData = new Uint8Array(width * height * 4);
    for (let i = 0; i < rasterData.length; i++) {
      const val = rasterData[i];
      // Only encode valid bloom days (1-365); leave 0 for no-data (ocean, etc.)
      const encoded = (val >= 1 && val <= 365) ? Math.round((val / 365.0) * 254) + 1 : 0;
      rgbaData[i * 4]     = encoded; // R = encoded bloom day
      rgbaData[i * 4 + 1] = encoded; // G
      rgbaData[i * 4 + 2] = encoded; // B
      rgbaData[i * 4 + 3] = 255;     // A = opaque
    }

    // Create texture with RGBA data
    this.geoTiffTexture = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.geoTiffTexture);
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_WRAP_S,
      this.gl.CLAMP_TO_EDGE
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_WRAP_T,
      this.gl.CLAMP_TO_EDGE
    );
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);

    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      width,
      height,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      rgbaData
    );

    console.log(`[GPU] Texture uploaded successfully (RGBA format), data length=${rgbaData.length} bytes`);
    
    // Debug: sample a few pixels to verify encoding
    const samplePixels = [0, Math.floor(width*height/2), width*height-1];
    console.log("[GPU] Sample texture values (R channel = encoded bloom day):");
    for (const idx of samplePixels) {
      const origVal = rasterData[idx];
      const uploadedVal = rgbaData[idx * 4];
      const decoded = uploadedVal > 0 ? Math.round(((uploadedVal - 1) / 254.0) * 365) : 0;
      console.log(`  Pixel ${idx}: Original=${origVal}, Encoded=${uploadedVal}, Decoded=${decoded}`);
    }
  }

  /**
   * Generate a single map tile as canvas
   * @param {number} z - zoom level
   * @param {number} x - tile column
   * @param {number} y - tile row
   * @returns {Promise<HTMLCanvasElement>}
   */
  clearCache() {
    this.tileCache.clear();
  }

  async generateTile(z, x, y, dayOfYear) {
    if (!this.initialized || !this.geoTiffData) {
      console.warn("Tile processor not ready");
      return null;
    }

    // Cache key includes dayOfYear so different days render fresh
    const cacheKey = `${z}/${x}/${y}/${dayOfYear}`;
    if (this.tileCache.has(cacheKey)) {
      return this.tileCache.get(cacheKey);
    }

    // Get tile bounding box in geographic coordinates
    const bbox = tileBounds(x, y, z);
    const tileBbox = [bbox.west, bbox.south, bbox.east, bbox.north];

    console.log(`[GPU] Rendering tile z${z}/${x}/${y}: tileBbox=${JSON.stringify(tileBbox)}`);

    // Render tile using WebGL
    this.gl.useProgram(this.program);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);

    // Bind GeoTIFF texture
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.geoTiffTexture);
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, "rasterTexture"),
      0
    );

    // Set uniforms
    const bboxLoc = this.gl.getUniformLocation(this.program, "bbox");
    const geoTiffBbox = this.geoTiffData.bbox;
    console.log(`[GPU] Shader uniforms for z${z}/${x}/${y}:`);
    console.log(`  GeoTIFF bbox: [W=${geoTiffBbox[0].toFixed(1)}, S=${geoTiffBbox[1].toFixed(1)}, E=${geoTiffBbox[2].toFixed(1)}, N=${geoTiffBbox[3].toFixed(1)}]`);
    this.gl.uniform4f(
      bboxLoc,
      geoTiffBbox[0],
      geoTiffBbox[1],
      geoTiffBbox[2],
      geoTiffBbox[3]
    );

    const rasterSizeLoc = this.gl.getUniformLocation(this.program, "rasterSize");
    this.gl.uniform2f(
      rasterSizeLoc,
      this.geoTiffData.width,
      this.geoTiffData.height
    );

    const tileBboxLoc = this.gl.getUniformLocation(this.program, "tileBbox");
    console.log(`  Tile bbox:   [W=${tileBbox[0].toFixed(1)}, S=${tileBbox[1].toFixed(1)}, E=${tileBbox[2].toFixed(1)}, N=${tileBbox[3].toFixed(1)}]`);
    this.gl.uniform4f(tileBboxLoc, tileBbox[0], tileBbox[1], tileBbox[2], tileBbox[3]);

    const dayLoc = this.gl.getUniformLocation(this.program, "dayOfYear");
    this.gl.uniform1f(dayLoc, dayOfYear);

    // Clear and render
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);

    // Read back pixels and convert to canvas
    const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    this.gl.readPixels(
      0,
      0,
      TILE_SIZE,
      TILE_SIZE,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      pixels
    );

    // Debug: check if pixels have any color data
    let pixelCount = 0;
    let transparentCount = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 0) pixelCount++; // Count non-transparent pixels
      if (pixels[i + 3] === 0) transparentCount++;
    }
    console.log(`[GPU] Pixel stats: ${pixelCount} visible, ${transparentCount} transparent, out of ${TILE_SIZE * TILE_SIZE} total`);
    if (pixelCount === 0) {
      console.warn("[GPU] WARNING: All pixels are transparent! Check GeoTIFF data and shader.");
    }

    // Create result canvas
    // NO Y-FLIP: readPixels is already in the right order for MapLibre image source
    // MapLibre expects: row 0 = north (top), row 255 = south (bottom)
    // readPixels gives: index 0 = bottom (south), index end = top (north)
    // So we need to flip when copying to canvas
    const resultCanvas = document.createElement("canvas");
    resultCanvas.width = TILE_SIZE;
    resultCanvas.height = TILE_SIZE;
    const ctx = resultCanvas.getContext("2d");
    const imageData = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    
    // Flip Y axis: readPixels is bottom-up, canvas needs top-down
    for (let py = 0; py < TILE_SIZE; py++) {
      for (let px = 0; px < TILE_SIZE; px++) {
        const glIdx = (py * TILE_SIZE + px) * 4;
        const canvasIdx = ((TILE_SIZE - 1 - py) * TILE_SIZE + px) * 4;
        imageData.data[canvasIdx] = pixels[glIdx];
        imageData.data[canvasIdx + 1] = pixels[glIdx + 1];
        imageData.data[canvasIdx + 2] = pixels[glIdx + 2];
        imageData.data[canvasIdx + 3] = pixels[glIdx + 3];
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Cache result
    this.tileCache.set(cacheKey, resultCanvas);

    return resultCanvas;
  }

  /**
   * Create a MapLibre tile provider
   */
  createTileProvider() {
    return async (tile) => {
      const canvas = await this.generateTile(tile.z, tile.x, tile.y);
      if (!canvas) return null;
      return {
        data: canvas,
        // height: TILE_SIZE,
        // width: TILE_SIZE,
        // teeth: TILE_SIZE / 2,
      };
    };
  }

  dispose() {
    if (this.gl && this.geoTiffTexture) {
      this.gl.deleteTexture(this.geoTiffTexture);
    }
    if (this.gl && this.colorTexture) {
      this.gl.deleteTexture(this.colorTexture);
    }
    if (this.gl && this.framebuffer) {
      this.gl.deleteFramebuffer(this.framebuffer);
    }
    this.tileCache.clear();
  }
}

export default RasterTileProcessor;
