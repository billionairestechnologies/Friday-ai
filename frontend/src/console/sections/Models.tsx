import { lazy, Suspense, useState } from "react";
import { AdminPage } from "@/routes/admin";
import { Loading, PageHeader, Segmented } from "../ui";

const ModelMultipliers = lazy(() => import("./ModelMultipliers"));

export default function Models() {
  const [tab, setTab] = useState<"keys" | "multipliers">("keys");
  return (
    <>
      <PageHeader
        title="Models & keys"
        description="Provider API keys, health checks, model discovery, which plan each model needs, and how much of the allowance each model costs."
        actions={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "keys", label: "Models & keys" },
              { value: "multipliers", label: "Usage multipliers" },
            ]}
          />
        }
      />
      {tab === "keys" ? (
        <AdminPage embedded="providers" />
      ) : (
        <Suspense fallback={<Loading label="Loading multipliers" />}>
          <ModelMultipliers />
        </Suspense>
      )}
    </>
  );
}
