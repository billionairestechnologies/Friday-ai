import "dotenv/config";

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
  keyEncryptionSecret: process.env.KEY_ENCRYPTION_SECRET ?? "dev-only-insecure-secret",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  resendFromEmail: process.env.RESEND_FROM_EMAIL ?? "Friday <onboarding@resend.dev>",
  e2bApiKey: process.env.E2B_API_KEY ?? "",
};

export function assertSupabaseConfigured() {
  required("SUPABASE_URL", env.supabaseUrl);
  required("SUPABASE_SERVICE_ROLE_KEY", env.supabaseServiceRoleKey);
}
