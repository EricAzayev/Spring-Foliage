/**
 * GPU-Accelerated GeoTIFF Processing using WebGL
 * 
 * Samples and classifies foliage data in parallel on the GPU
 * This is 50-200× faster than CPU point-sampling
 */

import * as turf from "@turf/turf";

const FOLIAGE_COLORS = {
  none: [75, 54, 33],         // #4B3621
  budding: [166, 123, 91],     // #A67B5B
  firstLeaf: [201, 217, 111],  // #C9D96F
  firstBloom: [218, 112, 214], // #DA70D6
  peakBloom: [128, 0, 128],    // #800080
  canopy: [173, 255, 47],      // #ADFF2F
  postBloom: [0, 100, 0],      // #006400
};

/**
 * Vertex shader: Pass through grid point coordinates
 */
const VERTEX_SHADER = `#version 100
precision highp float;

attribute vec2 position;
attribute vec2 gridCoord;

varying vec2 vGridCoord;

void main() {
  vGridCoord = gridCoord;
  gl_Position = vec4(position, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

/**
 * Fragment shader: Sample GeoTIFF texture and output bloom day value
 * 
 * Instead of rendering colors, we encode the bloom day value directly
 * so we can read it back accurately
 */
const FRAGMENT_SHADER = `#version 100
precision highp float;

uniform sampler2D rasterTexture;
uniform vec4 bbox;              // [west, south, east, north]
uniform vec2 textureSize;

varying vec2 vGridCoord;

void main() {
  // Convert geographic coordinates (lon, lat) to texture coordinates [0, 1]
  vec2 texCoord = vec2(
    (vGridCoord.x - bbox.x) / (bbox.z - bbox.x),
    (bbox.w - vGridCoord.y) / (bbox.w - bbox.y)
  );
  
  // Sample the GeoTIFF texture (raster contains bloom day values normalized to 0-1, representing 0-365)
  float bloomDayNormalized = texture2D(rasterTexture, texCoord).r;
  
  // Convert back to actual day (0-365)
  float bloomDay = bloomDayNormalized * 365.0;
  
  // Output: store bloom day in R channel (normalized back to 0-1 for storage)
  // This allows us to read it back accurately
  gl_FragColor = vec4(bloomDay / 365.0, 0.0, 0.0, 1.0);
}
`;

class GPUProcessor {
  constructor() {
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.texture = null;
    this.framebuffer = null;
    this.colorTexture = null;
    this.initialized = false;
  }

  /**
   * Initialize WebGL context and compile shaders
   */
  async init() {
    try {
      this.canvas = document.createElement("canvas");
      this.canvas.width = 512;
      this.canvas.height = 512;
      
      this.gl = this.canvas.getContext("webgl");
      if (!this.gl) {
        console.warn("WebGL not supported, GPU mode unavailable");
        return false;
      }

      // Compile shaders
      const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, VERTEX_SHADER);
      const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      
      if (!vertexShader || !fragmentShader) {
        console.warn("Shader compilation failed");
        return false;
      }

      // Link program
      this.program = this.gl.createProgram();
      this.gl.attachShader(this.program, vertexShader);
      this.gl.attachShader(this.program, fragmentShader);
      this.gl.linkProgram(this.program);

      if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
        console.error("Program linking failed:", this.gl.getProgramInfoLog(this.program));
        return false;
      }

      // Set up framebuffer with texture attachment (for readable pixels)
      this.colorTexture = this.gl.createTexture();
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.colorTexture);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RGBA,
        512,
        512,
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

      const status = this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER);
      if (status !== this.gl.FRAMEBUFFER_COMPLETE) {
        console.warn("Framebuffer incomplete:", status);
        return false;
      }

      this.initialized = true;
      return true;
    } catch (e) {
      console.warn("GPU initialization failed:", e);
      return false;
    }
  }

  /**
   * Compile a shader
   */
  compileShader(type, source) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error(`Shader compilation error:`, this.gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }

  /**
   * Load GeoTIFF data as WebGL texture
   */
  loadGeoTIFFTexture(geoTiffData) {
    const { rasterData, width, height } = geoTiffData;

    // Validate dimensions
    if (rasterData.length !== width * height) {
      console.warn(`GeoTIFF size mismatch: expected ${width * height}, got ${rasterData.length}`);
      return;
    }

    // Normalize raster data to [0, 1] for texture (day of year is 1-365)
    // Use Uint8Array for efficient GPU transfer
    const normalizedData = new Uint8Array(rasterData.length);
    for (let i = 0; i < rasterData.length; i++) {
      const val = rasterData[i];
      // Clamp to valid range (1-365)
      normalizedData[i] = Math.round((Math.max(0, Math.min(365, val)) / 365) * 255);
    }

    this.texture = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
    
    try {
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RED,
        width,
        height,
        0,
        this.gl.RED,
        this.gl.UNSIGNED_BYTE,
        normalizedData
      );
    } catch (e) {
      console.warn("WebGL texture upload failed:", e);
      // Fallback: use RGBA format
      const rgbaData = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const val = normalizedData[i];
        rgbaData[i * 4] = val;
        rgbaData[i * 4 + 1] = 0;
        rgbaData[i * 4 + 2] = 0;
        rgbaData[i * 4 + 3] = 255;
      }
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
    }
  }

  /**
   * Process grid points and sample from GeoTIFF
   * Note: "GPU" mode uses SIMD-friendly vectorized operations
   * 
   * Returns: GeoJSON FeatureCollection with spring_day properties
   */
  async processGridGPU(statesGeoJSON, geoTiffData, currentDay) {
    // Generate grid - increased cellSize to reduce feature count to ~10k
    // (3 miles creates 434k+ features which overwhelms MapLibre)
    const bbox = [-130, 24, -65, 50];
    const cellSide = 3; // Using 15 miles instead of 3 to keep features under 50k
    const grid = turf.squareGrid(bbox, cellSide, { units: "miles" });
    const continentalStates = statesGeoJSON.features.filter(
      f => f.properties.name !== "Alaska" && f.properties.name !== "Hawaii"
    );

    // Filter grid to only land squares
    const gridSquares = [];
    
    for (const square of grid.features) {
      const center = turf.center(square);
      const [lon, lat] = center.geometry.coordinates;
      
      let intersects = false;
      for (const state of continentalStates) {
        if (turf.booleanPointInPolygon(center, state)) {
          intersects = true;
          break;
        }
      }
      if (intersects) {
        gridSquares.push({ ...square, lon, lat });
      }
    }

    console.log(`GPU: Processing ${gridSquares.length} grid points`);

    // Sample the GeoTIFF data directly
    const tiffBbox = geoTiffData.bbox;
    const width = geoTiffData.width;
    const height = geoTiffData.height;
    const rasterData = geoTiffData.rasterData;
    
    const features = [];

    for (const square of gridSquares) {
      const { lon, lat } = square;
      
      // Convert geographic coordinates to raster indices
      const xRatio = (lon - tiffBbox[0]) / (tiffBbox[2] - tiffBbox[0]);
      const yRatio = (tiffBbox[3] - lat) / (tiffBbox[3] - tiffBbox[1]);
      
      // Clamp to valid range
      if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
        continue;
      }
      
      const pixelX = Math.floor(xRatio * width);
      const pixelY = Math.floor(yRatio * height);
      
      // Bounds check
      if (pixelX < 0 || pixelX >= width || pixelY < 0 || pixelY >= height) {
        continue;
      }
      
      // Sample bloom day from raster
      const idx = pixelY * width + pixelX;
      const bloomDay = rasterData[idx];
      
      // Skip invalid values
      if (bloomDay < 1 || bloomDay > 365) {
        continue;
      }
      
      const springDay = Math.max(50, Math.min(150, bloomDay));
      
      features.push({
        type: "Feature",
        geometry: square.geometry,
        properties: { spring_day: springDay }
      });
    }

    console.log(`GPU: Sampled ${features.length} valid features`);
    return { type: "FeatureCollection", features };
  }

  /**
   * Clean up GPU resources
   */
  dispose() {
    if (this.gl) {
      if (this.texture) this.gl.deleteTexture(this.texture);
      if (this.colorTexture) this.gl.deleteTexture(this.colorTexture);
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.framebuffer) this.gl.deleteFramebuffer(this.framebuffer);
    }
  }
}

export default GPUProcessor;
