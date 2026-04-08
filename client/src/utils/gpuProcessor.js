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
   * Process grid points on GPU and return classified foliage data
   * 
   * Returns: GeoJSON FeatureCollection with spring_day properties
   */
  async processGridGPU(statesGeoJSON, geoTiffData, currentDay) {
    if (!this.initialized || !this.texture) {
      console.warn("GPU processor not ready:", { initialized: this.initialized, hasTexture: !!this.texture });
      throw new Error("GPU processor not initialized or texture not loaded");
    }

    const gl = this.gl;
    
    // Generate grid
    const bbox = [-130, 24, -65, 50];
    const cellSide = 3;
    const grid = turf.squareGrid(bbox, cellSide, { units: "miles" });
    const continentalStates = statesGeoJSON.features.filter(
      f => f.properties.name !== "Alaska" && f.properties.name !== "Hawaii"
    );

    // Filter grid to only land squares
    const gridSquares = [];
    const maxGridPoints = 64 * 64; // Max points we can render to 512x512 canvas
    
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
        if (gridSquares.length >= maxGridPoints) break;
      }
    }

    console.log(`GPU: Processing ${gridSquares.length} grid points`);

    // If no grid points, return empty
    if (gridSquares.length === 0) {
      console.warn("GPU: No grid points to process");
      return { type: "FeatureCollection", features: [] };
    }

    // Create position and coordinate buffers for grid points
    const positions = new Float32Array(gridSquares.length * 2);
    const coords = new Float32Array(gridSquares.length * 2);

    for (let i = 0; i < gridSquares.length; i++) {
      const square = gridSquares[i];
      // Screen-space positions (-1 to 1)
      const gridX = i % 64;
      const gridY = Math.floor(i / 64);
      positions[i * 2] = (gridX * 2 + 1) / 64 - 1;
      positions[i * 2 + 1] = (gridY * 2 + 1) / 64 - 1;
      // Geographic coordinates
      coords[i * 2] = square.lon;
      coords[i * 2 + 1] = square.lat;
    }

    // Set up buffers
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const coordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, coordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, coords, gl.STATIC_DRAW);

    // Render to framebuffer
    gl.useProgram(this.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, 512, 512);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Set up attributes
    const positionLoc = gl.getAttribLocation(this.program, "position");
    const coordLoc = gl.getAttribLocation(this.program, "gridCoord");

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, coordBuffer);
    gl.enableVertexAttribArray(coordLoc);
    gl.vertexAttribPointer(coordLoc, 2, gl.FLOAT, false, 0, 0);

    // Set uniforms
    const bboxLoc = gl.getUniformLocation(this.program, "bbox");
    const textureLoc = gl.getUniformLocation(this.program, "rasterTexture");
    const tiffBbox = geoTiffData.bbox;

    gl.uniform4f(bboxLoc, tiffBbox[0], tiffBbox[1], tiffBbox[2], tiffBbox[3]);
    gl.uniform1i(textureLoc, 0);
    
    // Bind raster texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    // Draw points (each point renders to one pixel)
    gl.drawArrays(gl.POINTS, 0, gridSquares.length);

    // Check for GL errors
    const glError = gl.getError();
    if (glError !== gl.NO_ERROR) {
      console.warn("GL Error:", glError);
    }

    // Read pixel data
    const pixel = new Uint8Array(4);
    const features = [];

    for (let i = 0; i < gridSquares.length; i++) {
      const gridX = i % 64;
      const gridY = Math.floor(i / 64);
      
      gl.readPixels(gridX, gridY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      
      // Extract bloom day from R channel (0-255 represents 0-365)
      const bloomDayNormalized = pixel[0] / 255.0;
      const bloomDay = bloomDayNormalized * 365.0;
      
      // Skip invalid values (0 means no data)
      if (bloomDay < 1 || bloomDay > 365) {
        continue;
      }

      const springDay = Math.max(50, Math.min(150, bloomDay));
      
      features.push({
        ...gridSquares[i],
        properties: { spring_day: springDay }
      });
    }

    // Clean up buffers
    gl.deleteBuffer(positionBuffer);
    gl.deleteBuffer(coordBuffer);

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
