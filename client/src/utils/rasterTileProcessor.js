/**
 * GPU-Accelerated Raster Tile Generator
 * 
 * Generates map tiles on-the-fly using WebGL to sample GeoTIFF data
 * and render them as colored raster images. Supports zoom levels 0-15.
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
uniform int zoomLevel;

varying vec2 vTexCoord;

// Map pixel coordinates to foliage color based on bloom day
vec3 bloomDayToColor(float bloomDay) {
  // Color gradient for foliage phenology
  vec3 postBloom = vec3(0.0, 100.0, 0.0) / 255.0;    // [0, 100, 0]
  vec3 budding = vec3(166.0, 123.0, 91.0) / 255.0;   // [166, 123, 91]
  vec3 firstLeaf = vec3(201.0, 217.0, 111.0) / 255.0; // [201, 217, 111]
  vec3 firstBloom = vec3(218.0, 112.0, 214.0) / 255.0; // [218, 112, 214]
  vec3 peakBloom = vec3(128.0, 0.0, 128.0) / 255.0;  // [128, 0, 128]
  vec3 canopy = vec3(173.0, 255.0, 47.0) / 255.0;    // [173, 255, 47]
  vec3 none = vec3(75.0, 54.0, 33.0) / 255.0;        // [75, 54, 33]
  
  if (bloomDay < 50.0) {
    float t = bloomDay / 50.0;
    return mix(none, budding, t);
  } else if (bloomDay < 80.0) {
    float t = (bloomDay - 50.0) / 30.0;
    return mix(budding, firstLeaf, t);
  } else if (bloomDay < 100.0) {
    float t = (bloomDay - 80.0) / 20.0;
    return mix(firstLeaf, firstBloom, t);
  } else if (bloomDay < 120.0) {
    float t = (bloomDay - 100.0) / 20.0;
    return mix(firstBloom, peakBloom, t);
  } else if (bloomDay < 140.0) {
    float t = (bloomDay - 120.0) / 20.0;
    return mix(peakBloom, canopy, t);
  } else if (bloomDay < 160.0) {
    float t = (bloomDay - 140.0) / 20.0;
    return mix(canopy, postBloom, t);
  } else {
    return postBloom;
  }
}

void main() {
  // Convert tile pixel coordinates to geographic coordinates
  float lon = tileBbox.x + vTexCoord.x * (tileBbox.z - tileBbox.x);
  float lat = tileBbox.w - vTexCoord.y * (tileBbox.w - tileBbox.y);
  
  // Convert geographic coordinates to GeoTIFF raster coordinates
  float xRatio = (lon - bbox.x) / (bbox.z - bbox.x);
  float yRatio = (bbox.w - lat) / (bbox.w - bbox.y);
  
  // Check bounds
  if (xRatio < 0.0 || xRatio > 1.0 || yRatio < 0.0 || yRatio > 1.0) {
    discard;
  }
  
  // Sample the GeoTIFF
  vec2 rasterCoord = vec2(xRatio, yRatio);
  float bloomDayNormalized = texture2D(rasterTexture, rasterCoord).r;
  float bloomDay = bloomDayNormalized * 365.0;
  
  // Skip invalid pixels
  if (bloomDay < 1.0) {
    discard;
  }
  
  // Map to color
  vec3 color = bloomDayToColor(bloomDay);
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

    // Normalize raster data to [0, 1] range
    const normalized = new Uint8Array(width * height);
    for (let i = 0; i < rasterData.length; i++) {
      const val = Math.max(0, Math.min(365, rasterData[i]));
      normalized[i] = Math.round((val / 365) * 255);
    }

    // Create texture
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
      this.gl.RED,
      this.gl.UNSIGNED_BYTE,
      normalized
    );

    console.log(`[GPU] Texture uploaded successfully`);
  }

  /**
   * Generate a single map tile as canvas
   * @param {number} z - zoom level
   * @param {number} x - tile column
   * @param {number} y - tile row
   * @returns {Promise<HTMLCanvasElement>}
   */
  async generateTile(z, x, y) {
    if (!this.initialized || !this.geoTiffData) {
      console.warn("Tile processor not ready");
      return null;
    }

    // Check cache
    const cacheKey = `${z}/${x}/${y}`;
    if (this.tileCache.has(cacheKey)) {
      return this.tileCache.get(cacheKey);
    }

    // Get tile bounding box in geographic coordinates
    const bbox = tileBounds(x, y, z);
    const tileBbox = [bbox.west, bbox.south, bbox.east, bbox.north];

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
    this.gl.uniform4f(tileBboxLoc, tileBbox[0], tileBbox[1], tileBbox[2], tileBbox[3]);

    const zoomLoc = this.gl.getUniformLocation(this.program, "zoomLevel");
    this.gl.uniform1i(zoomLoc, z);

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
    const resultCanvas = document.createElement("canvas");
    resultCanvas.width = TILE_SIZE;
    resultCanvas.height = TILE_SIZE;
    const ctx = resultCanvas.getContext("2d");
    const imageData = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    
    // Flip Y axis (WebGL is bottom-up, canvas is top-down)
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
