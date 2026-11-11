export const SUPABASE_SNOW_TILES_URL =
  "https://hsuqpowsxssezkbpkrwk.supabase.co/storage/v1/object/public/snow_tiles";

export const SUPABASE_SNOW_MANIFEST_URL = `${SUPABASE_SNOW_TILES_URL}/index.json`;

// Single in-session fetch shared by App (availability check) and Map
// (manifest-driven rendering). A failed attempt isn't cached, so a transient
// Supabase hiccup during startup doesn't pin the empty manifest for the
// whole session.
let snowManifestPromise = null;
export const fetchSnowTileManifest = () => {
  if (!snowManifestPromise) {
    snowManifestPromise = fetch(SUPABASE_SNOW_MANIFEST_URL, { cache: "no-store" }).then(
      (response) => {
        if (!response.ok) {
          snowManifestPromise = null;
          throw new Error(`Manifest HTTP ${response.status}`);
        }
        return response.json();
      },
      (error) => {
        snowManifestPromise = null;
        throw error;
      },
    );
  }
  return snowManifestPromise;
};
