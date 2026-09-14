import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ModelOption } from "../lib/types";

interface Props {
  value: string; // `${providerSlug}::${modelId}`
  onChange: (value: string, model: ModelOption | null) => void;
  disabled?: boolean;
}

export function ModelSelector({ value, onChange, disabled }: Props) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ models: ModelOption[] }>("/models")
      .then((res) => setModels(res.models))
      .catch(() => setError("Couldn't load models"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="model-selector model-selector--loading">Loading models…</div>;
  if (error) return <div className="model-selector model-selector--error">{error}</div>;
  if (models.length === 0) {
    return <div className="model-selector model-selector--empty">No models enabled yet — ask an admin.</div>;
  }

  return (
    <select
      className="model-selector"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const key = e.target.value;
        const model = models.find((m) => `${m.providers.slug}::${m.model_id}` === key) ?? null;
        onChange(key, model);
      }}
    >
      <option value="" disabled>
        Select a model…
      </option>
      {models.map((m) => (
        <option key={m.id} value={`${m.providers.slug}::${m.model_id}`}>
          {m.providers.display_name} — {m.display_name}
        </option>
      ))}
    </select>
  );
}
