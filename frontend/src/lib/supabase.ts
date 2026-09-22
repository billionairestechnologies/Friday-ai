import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Used only for Realtime (live cross-device chat sync) — never for auth or table writes, both
 *  of which stay routed through the backend. `null` when the env vars aren't set (e.g. a fork
 *  without Supabase configured), in which case realtime sync just doesn't start. */
export const supabase = url && anonKey ? createClient(url, anonKey, { auth: { persistSession: false } }) : null;
