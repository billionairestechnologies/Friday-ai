import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * Service-role client: full DB access, used only in backend services
 * (admin routes, provider sync, chat persistence). Never expose this key to the frontend.
 */
export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Builds a request-scoped client that acts as the calling user (respects RLS),
 * used to verify the user's JWT from the Authorization header.
 */
export function supabaseAsUser(accessToken: string) {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
