/**
 * BROWSER CONSOLE DEBUGGING SCRIPT
 * 
 * Copy this entire script into the browser console (F12 → Console tab)
 * This will help diagnose remaining GPU rendering issues
 */

// ===== TEST 1: Verify Coordinate Mappings =====
window.testCoordinates = function() {
  console.log("\n=== TEST 1: Coordinate Mappings ===");
  
  // Simulate a tile render at zoom 3, USA center
  const z = 3, x = 2, y = 2;
  const n = Math.pow(2, z);
  
  // Calculate tile bounds (same logic as tileBounds function)
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const south = Math.atan(Math.sinh(-Math.PI * (2 * (y + 1) / n - 1))) * 180 / Math.PI;
  const north = Math.atan(Math.sinh(-Math.PI * (2 * y / n - 1))) * 180 / Math.PI;
  
  console.log(`Tile z${z}/${x}/${y} bounds:`);
  console.log(`  West:  ${west.toFixed(2)}°`);
  console.log(`  East:  ${east.toFixed(2)}°`);
  console.log(`  South: ${south.toFixed(2)}°`);
  console.log(`  North: ${north.toFixed(2)}°`);
  
  // Check if bounds make sense
  if (west > east) console.warn("  ❌ ERROR: West > East!");
  if (south > north) console.warn("  ❌ ERROR: South > North!");
  console.log("  ✓ Tile bounds valid");
};

// ===== TEST 2: Verify GeoTIFF Bounds Assumptions =====
window.testGeoTIFFAssumptions = function() {
  console.log("\n=== TEST 2: GeoTIFF Bounds Assumptions ===");
  console.log("Expected GeoTIFF.js behavior:");
  console.log("  • getBoundingBox() returns [minX, minY, maxX, maxY]");
  console.log("  • For WGS84: minX = westernmost, maxX = easternmost");
  console.log("  • For WGS84: minY = southernmost, maxY = northernmost");
  console.log("  • Therefore: bbox = [West, South, East, North]");
  console.log("\nTo verify your GeoTIFF:");
  console.log("  1. Open console when map loads");
  console.log("  2. Find message '[GPU] GeoTIFF bounds: W=..., S=..., E=..., N=...'");
  console.log("  3. Check values are approximately: W≈-130, S≈25, E≈-65, N≈48");
  console.log("  4. If W>E or S>N, the format is non-standard");
};

// ===== TEST 3: Check WebGL Errors =====
window.testWebGLErrors = function() {
  console.log("\n=== TEST 3: WebGL Errors ===");
  console.log("To check for WebGL errors:");
  console.log("  1. Open DevTools (F12)");
  console.log("  2. Go to Console tab");
  console.log("  3. Look for any messages starting with 'WebGL'");
  console.log("  4. If you see errors, the shader compilation failed");
  console.log("\nCommon WebGL errors:");
  console.log("  • 'WebGL context lost' → driver issue");
  console.log("  • 'INVALID_ENUM' or 'INVALID_OPERATION' → shader bug");
  console.log("  • Silent failures → texture upload or uniform issue");
};

// ===== TEST 4: Monitor Pixel Statistics =====
window.testPixelStats = function() {
  console.log("\n=== TEST 4: Pixel Statistics Interpretation ===");
  console.log("Watch console during tile render. You'll see:");
  console.log("  '[GPU] Pixel stats: X visible, Y transparent, out of 65536 total'");
  console.log("\nInterpretation:");
  console.log("  • X=65536, Y=0:  All pixels opaque (likely incorrect coordinates or no texture)");
  console.log("  • X=0-1000, Y=64000+: Some tiles rendering (may be mostly no-data)");
  console.log("  • X=25000-50000: Mixed opaque/transparent (healthy)");
  console.log("  • X=0, Y=65536: All transparent (shader returned alpha=0)");
};

// ===== TEST 5: Visual Coordinate Check =====
window.testVisualCoordinates = function() {
  console.log("\n=== TEST 5: Visual Coordinate Check ===");
  console.log("After fixing Y-axis, with CPU mode (working reference):");
  console.log("  1. Bloom should appear dark in south, light in north (spatially)");
  console.log("  2. Toggle GPU ↔ CPU mode - should match spatially");
  console.log("  3. Colors may differ (GPU vs CPU), but positions should match");
  console.log("\nSign something is WRONG:");
  console.log("  • GPU tiles appear upside-down");
  console.log("  • GPU tiles appear left-right flipped");
  console.log("  • GPU tiles don't overlap where CPU tiles do");
};

// ===== TEST 6: Shader Coordinate Formulas =====
window.testShaderFormulas = function() {
  console.log("\n=== TEST 6: Shader Coordinate Formulas ===");
  console.log("The fixed shader should use:");
  console.log("  yRatio = (lat - bbox.y) / (bbox.w - bbox.y)");
  console.log("           ^^^^^^^^   ^^^^^  ^^^^^");
  console.log("           latitude  south  north");
  console.log("\nThis ensures:");
  console.log("  • When lat=south (bbox.y): yRatio=0 → samples bottom of texture");
  console.log("  • When lat=north (bbox.w): yRatio=1 → samples top of texture");
  console.log("  • Texture y=0 is bottom of image, y=1 is top (WebGL convention)");
  console.log("\nTo inspect shader, check browser DevTools:");
  console.log("  1. Go to DevTools → Rendering tab");
  console.log("  2. Look for fragment shader source in WebGL debugging tools");
};

// ===== TEST 7: Check Tile Position =====
window.testTilePosition = function() {
  console.log("\n=== TEST 7: Tile Position Check ===");
  console.log("After tiles render:");
  console.log("  1. Look at map - expect 256x256 tiles to appear");
  console.log("  2. Zoom in/out - tiles should stay positioned over features");
  console.log("  3. Pan around - tiles should slide correctly with map");
  console.log("\nIf tiles are positioned WRONG:");
  console.log("  ✗ Check tileBounds() function produces correct coordinates");
  console.log("  ✗ Verify MapLibre coordinate array is [NW, NE, SE, SW]");
  console.log("  ✗ Check image source URL is valid blob");
};

// ===== MASTER TEST =====
window.runAllTests = function() {
  console.clear();
  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║  GPU Tile Renderer - Diagnostic Test Suite              ║");
  console.log("╚════════════════════════════════════════════════════════╝");
  
  window.testCoordinates();
  window.testGeoTIFFAssumptions();
  window.testWebGLErrors();
  window.testPixelStats();
  window.testVisualCoordinates();
  window.testShaderFormulas();
  window.testTilePosition();
  
  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║  NEXT STEPS:                                            ║");
  console.log("║  1. Check browser console for '[GPU]' logged messages   ║");
  console.log("║  2. Verify GeoTIFF bounds match expectations            ║");
  console.log("║  3. Toggle GPU mode ON and watch pixel stats            ║");
  console.log("║  4. Compare GPU vs CPU rendering visually               ║");
  console.log("║  5. If issues persist, post console output to debug     ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");
};

// ===== QUICK REFERENCE =====
console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║ GPU DEBUGGING SCRIPT LOADED                                              ║
║                                                                            ║
║ Available functions:                                                       ║
║   runAllTests()                  - Run all diagnostic tests                ║
║   testCoordinates()              - Verify tile math                        ║
║   testGeoTIFFAssumptions()       - Show expected bbox format               ║
║   testWebGLErrors()              - How to find WebGL errors                ║ 
║   testPixelStats()               - Interpret pixel output                  ║
║   testVisualCoordinates()        - Check spatial correctness               ║
║   testShaderFormulas()           - Review coordinate formulas              ║
║   testTilePosition()             - Verify tiles appear on map              ║
║                                                                            ║
║ QUICK START:                                                              ║
║   Type: runAllTests()                                                      ║
║                                                                            ║
╚═══════════════════════════════════════════════════════════════════════════╝
`);
