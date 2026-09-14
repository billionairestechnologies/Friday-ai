import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { AUTO_VALUE, encodeModelValue, TEAMUP_VALUE } from "../lib/modelSelection";
import type { ModelOption } from "../lib/types";

interface Props {
  value: string; // AUTO_VALUE, TEAMUP_VALUE, or `${providerSlug}::${modelId}`
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

  return (
    <select
      className="model-selector"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const key = e.target.value;
        if (key === AUTO_VALUE || key === TEAMUP_VALUE) {
          onChange(key, null);
          return;
        }
        const model = models.find((m) => encodeModelValue(m.providers.slug, m.model_id) === key) ?? null;
        onChange(key, model);
      }}
    >
      <option value="" disabled>
        Select a model…
      </option>
      <option value={AUTO_VALUE}>🔀 Auto — picks a working model for you</option>
      <option value={TEAMUP_VALUE}>👥 Team Up — ask several models at once</option>
      {models.length === 0 && <option disabled>No individual models enabled yet — ask an admin</option>}
      {models.map((m) => (
        <option key={m.id} value={encodeModelValue(m.providers.slug, m.model_id)}>
          {m.providers.display_name} — {m.display_name}
        </option>
      ))}
    </select>
  );
}
