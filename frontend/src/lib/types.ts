export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  role?: "user" | "admin";
}

export interface Session {
  access_token: string;
  refresh_token: string;
}

export interface ModelOption {
  id: string;
  model_id: string;
  display_name: string;
  capabilities: { chat?: boolean; vision?: boolean; tts?: boolean; stt?: boolean };
  providers: { slug: string; display_name: string };
}

export interface Conversation {
  id: string;
  title: string;
  model_id: string;
  provider_id: string;
  providers: { slug: string; display_name: string };
  updated_at: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  input_mode: "text" | "voice";
  created_at: string;
}

export interface ProviderKey {
  id: string;
  provider_id: string;
  label: string;
  masked_preview: string;
  is_active: boolean;
  is_working: boolean | null;
  last_checked_at: string | null;
  last_error: string | null;
}

export interface ProviderWithStatus {
  id: string;
  slug: string;
  display_name: string;
  keys: ProviderKey[];
  modelCount: number;
  enabledModelCount: number;
}

export interface ProviderModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  capabilities: Record<string, boolean>;
  is_enabled_for_users: boolean;
}
