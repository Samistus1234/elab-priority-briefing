import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "./config.js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const { supabase } = loadConfig();
  client = createClient(supabase.url, supabase.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  });
  return client;
}
