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

function truthy(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  corsOrigins: commaSeparated(process.env.CORS_ORIGIN, "http://localhost:5173"),
  trustProxy: process.env.TRUST_PROXY ?? "",
  publicAppUrl: process.env.PUBLIC_APP_URL ?? "http://localhost:5173",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
  keyEncryptionSecret: process.env.KEY_ENCRYPTION_SECRET ?? "dev-only-insecure-secret",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  githubRedirectUri:
    process.env.GITHUB_REDIRECT_URI ??
    `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/connectors/github/callback`,
  redisUrl: process.env.REDIS_URL ?? "",
  attachmentObjectStorageEnabled: truthy(process.env.ATTACHMENT_OBJECT_STORAGE, true),
  ssoEnabled: truthy(process.env.SSO_ENABLED, false),
  ssoEntryUrl: process.env.SSO_ENTRY_URL ?? "",
  ssoProviderLabel: process.env.SSO_PROVIDER_LABEL ?? "Company SSO",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  resendFromEmail: process.env.RESEND_FROM_EMAIL ?? "Friday <onboarding@resend.dev>",
  e2bApiKey: process.env.E2B_API_KEY ?? "",
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? "",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
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
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  razorpayWebhookSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  ssoEnabled?: boolean;
  ssoEntryUrl?: string;
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

  const razorpayValues = [input.razorpayKeyId, input.razorpayKeySecret, input.razorpayWebhookSecret].filter(Boolean);
  if (razorpayValues.length > 0 && razorpayValues.length < 3) {
    errors.push("RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_WEBHOOK_SECRET must be configured together");
  }

  const githubValues = [input.githubClientId, input.githubClientSecret].filter(Boolean);
  if (githubValues.length === 1) {
    errors.push("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured together");
  }

  if (input.ssoEnabled && !input.ssoEntryUrl) {
    errors.push("SSO_ENTRY_URL is required when SSO_ENABLED=true");
  }

  return errors;
}

export function assertEnvironmentConfigured() {
  const errors = validateEnvironment(env);
  if (errors.length > 0) {
    throw new Error(`Invalid server configuration:\n- ${errors.join("\n- ")}`);
  }
}
