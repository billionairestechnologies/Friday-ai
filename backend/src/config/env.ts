import "dotenv/config";

const INSECURE_ENCRYPTION_SECRETS = new Set([
  "",
  "change-me",
  "change-me-to-a-32-byte-random-string",
  "dev-only-insecure-secret",
]);

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function commaSeparated(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  corsOrigins: commaSeparated(process.env.CORS_ORIGIN, "http://localhost:5173"),
  trustProxy: process.env.TRUST_PROXY ?? "",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
  keyEncryptionSecret: process.env.KEY_ENCRYPTION_SECRET ?? "dev-only-insecure-secret",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  resendFromEmail: process.env.RESEND_FROM_EMAIL ?? "Friday <onboarding@resend.dev>",
  e2bApiKey: process.env.E2B_API_KEY ?? "",
  rateLimits: {
    authPer15Minutes: positiveInteger(process.env.AUTH_RATE_LIMIT_MAX, 10),
    otpPer10Minutes: positiveInteger(process.env.OTP_RATE_LIMIT_MAX, 5),
    chatPerMinute: positiveInteger(process.env.CHAT_RATE_LIMIT_MAX, 20),
    chatPerDay: positiveInteger(process.env.CHAT_DAILY_LIMIT_MAX, 100),
    chatConcurrency: positiveInteger(process.env.CHAT_CONCURRENCY_MAX, 2),
    voicePer15Minutes: positiveInteger(process.env.VOICE_RATE_LIMIT_MAX, 30),
    voiceConcurrency: positiveInteger(process.env.VOICE_CONCURRENCY_MAX, 2),
    sandboxPer10Minutes: positiveInteger(process.env.SANDBOX_RATE_LIMIT_MAX, 5),
    sandboxConcurrency: positiveInteger(process.env.SANDBOX_CONCURRENCY_MAX, 1),
  },
};

type EnvironmentInput = {
  nodeEnv: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabaseAnonKey: string;
  keyEncryptionSecret: string;
  resendApiKey: string;
};

export function validateEnvironment(input: EnvironmentInput): string[] {
  const errors: string[] = [];
  if (!input.supabaseUrl) errors.push("SUPABASE_URL is required");
  if (!input.supabaseServiceRoleKey) errors.push("SUPABASE_SERVICE_ROLE_KEY is required");
  if (!input.supabaseAnonKey) errors.push("SUPABASE_ANON_KEY is required");

  if (input.nodeEnv === "production") {
    if (
      INSECURE_ENCRYPTION_SECRETS.has(input.keyEncryptionSecret) ||
      Buffer.byteLength(input.keyEncryptionSecret, "utf8") < 32
    ) {
      errors.push("KEY_ENCRYPTION_SECRET must be a unique secret of at least 32 bytes");
    }
    if (!input.resendApiKey) errors.push("RESEND_API_KEY is required because login uses email OTP");
  }

  return errors;
}

export function assertEnvironmentConfigured() {
  const errors = validateEnvironment(env);
  if (errors.length > 0) {
    throw new Error(`Invalid server configuration:\n- ${errors.join("\n- ")}`);
  }
}
