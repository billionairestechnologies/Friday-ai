import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/** Anon-key client used only for the unauthenticated signup/login handshake. */
export const supabasePublic = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
