// Placeholder config so modules that build a Supabase client at import time (services that pull in
// config/supabase.ts) can be loaded by unit tests without a real project. Real values, when set,
// win; no test talks to Supabase over the network.
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_ANON_KEY ??= "test-anon-key";
