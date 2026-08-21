import { createClient } from "@supabase/supabase-js";

// Strip any trailing path (e.g. /rest/v1/) — the client constructs its own URLs
const rawUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseUrl = rawUrl.replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");

const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

if (!hasSupabaseConfig) {
	console.warn("Supabase environment variables are missing; analytics is disabled.");
}

export const supabase = hasSupabaseConfig
	? createClient(supabaseUrl, supabaseAnonKey)
	: null;

export { supabaseUrl, supabaseAnonKey };
