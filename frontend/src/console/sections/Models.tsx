import { AdminPage } from "@/routes/admin";
import { PageHeader } from "../ui";

export default function Models() {
  return (
    <>
      <PageHeader title="Models & keys" description="Provider API keys, health checks, model discovery, and which plan each model needs." />
      <AdminPage embedded="providers" />
    </>
  );
}
