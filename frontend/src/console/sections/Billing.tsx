import { AdminPage } from "@/routes/admin";
import { PageHeader } from "../ui";

export default function Billing() {
  return (
    <>
      <PageHeader title="Billing & usage" description="Every user's plan and cap, enterprise seats and pooled tokens, and revenue vs. model cost." />
      <AdminPage embedded="plans" />
    </>
  );
}
