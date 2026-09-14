import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../lib/api";
import type { ProviderModelRow, ProviderWithStatus } from "../../lib/types";

export function AdminPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ProviderWithStatus[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, ProviderModelRow[]>>({});
  const [keyLabel, setKeyLabel] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (user && user.role !== "admin") navigate("/chat");
  }, [user, navigate]);

  function refreshProviders() {
    api.get<{ providers: ProviderWithStatus[] }>("/admin/providers").then((res) => setProviders(res.providers));
  }

  useEffect(refreshProviders, []);

  function loadModels(slug: string) {
    api.get<{ models: ProviderModelRow[] }>(`/admin/providers/${slug}/models`).then((res) =>
      setModels((prev) => ({ ...prev, [slug]: res.models })),
    );
  }

  async function addKey(slug: string) {
    if (!keyValue.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.post<{ discoveredModels: number; health: { ok: boolean; error?: string } }>(
        `/admin/providers/${slug}/keys`,
        { label: keyLabel || "default", apiKey: keyValue },
      );
      setNotice(
        res.health.ok
          ? `Key added and verified — found ${res.discoveredModels} models.`
          : `Key added but the health check failed: ${res.health.error}`,
      );
      setKeyLabel("");
      setKeyValue("");
      refreshProviders();
      loadModels(slug);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to add key");
    } finally {
      setBusy(false);
    }
  }

  async function deleteKey(keyId: string, slug: string) {
    await api.delete(`/admin/providers/keys/${keyId}`);
    refreshProviders();
    loadModels(slug);
  }

  async function checkKey(keyId: string) {
    setBusy(true);
    try {
      await api.post(`/admin/providers/keys/${keyId}/check`);
      refreshProviders();
    } finally {
      setBusy(false);
    }
  }

  async function checkAll() {
    setBusy(true);
    setNotice("Checking all keys…");
    try {
      await api.post("/admin/providers/keys/check-all");
      setNotice("Health check complete.");
      refreshProviders();
    } finally {
      setBusy(false);
    }
  }

  async function syncModels(slug: string) {
    setBusy(true);
    try {
      const res = await api.post<{ discoveredModels: number }>(`/admin/providers/${slug}/sync`);
      setNotice(`Synced ${res.discoveredModels} models for ${slug}.`);
      refreshProviders();
      loadModels(slug);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleModel(modelId: string, slug: string, enabled: boolean) {
    await api.patch(`/admin/providers/models/${modelId}`, { enabled });
    loadModels(slug);
    refreshProviders();
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <h1>Admin Panel</h1>
        <div>
          <button className="link-btn" onClick={checkAll} disabled={busy}>
            Check all keys
          </button>
          <a className="link-btn" href="/chat">
            Back to chat
          </a>
        </div>
      </header>

      {notice && <div className="admin-notice">{notice}</div>}

      <div className="provider-grid">
        {providers.map((p) => (
          <div key={p.id} className="provider-card">
            <div className="provider-card-header" onClick={() => {
              setExpanded(expanded === p.slug ? null : p.slug);
              if (!models[p.slug]) loadModels(p.slug);
            }}>
              <div>
                <strong>{p.display_name}</strong>
                <span className="provider-meta">
                  {p.enabledModelCount}/{p.modelCount} models shown to users
                </span>
              </div>
              <span>{expanded === p.slug ? "▲" : "▼"}</span>
            </div>

            {expanded === p.slug && (
              <div className="provider-card-body">
                <h4>API Keys</h4>
                {p.keys.length === 0 && <p className="empty-hint">No key added yet.</p>}
                {p.keys.map((k) => (
                  <div key={k.id} className="key-row">
                    <span className="key-preview">{k.masked_preview}</span>
                    <span className={`status-dot status-dot--${k.is_working ? "ok" : k.is_working === false ? "fail" : "unknown"}`} />
                    <span className="status-label">
                      {k.is_working === null ? "Not checked" : k.is_working ? "Working" : "Not working"}
                    </span>
                    <button className="link-btn" onClick={() => checkKey(k.id)} disabled={busy}>
                      Re-check
                    </button>
                    <button className="link-btn danger" onClick={() => deleteKey(k.id, p.slug)}>
                      Delete
                    </button>
                  </div>
                ))}

                <div className="add-key-row">
                  <input
                    placeholder="Label (optional)"
                    value={keyLabel}
                    onChange={(e) => setKeyLabel(e.target.value)}
                  />
                  <input
                    placeholder={p.slug === "ollama" ? "Server URL (e.g. http://localhost:11434)" : "API key"}
                    value={keyValue}
                    onChange={(e) => setKeyValue(e.target.value)}
                    type={p.slug === "ollama" ? "text" : "password"}
                  />
                  <button className="btn-primary" onClick={() => addKey(p.slug)} disabled={busy}>
                    Add
                  </button>
                </div>

                <div className="models-header">
                  <h4>Models</h4>
                  <button className="link-btn" onClick={() => syncModels(p.slug)} disabled={busy}>
                    Re-sync from API
                  </button>
                </div>
                {(models[p.slug] ?? []).map((m) => (
                  <label key={m.id} className="model-toggle-row">
                    <input
                      type="checkbox"
                      checked={m.is_enabled_for_users}
                      onChange={(e) => toggleModel(m.id, p.slug, e.target.checked)}
                    />
                    {m.display_name}
                    <span className="model-id">{m.model_id}</span>
                  </label>
                ))}
                {(models[p.slug] ?? []).length === 0 && (
                  <p className="empty-hint">No models discovered yet — add a working key first.</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
