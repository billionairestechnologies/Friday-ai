import { ScrollText } from "lucide-react";
import { Card, EmptyState, ErrorNote, Loading, PageHeader, formatDate, useResource } from "../ui";

type Entry = { id: string; actor_user_id: string; action: string; target_type: string; target_id: string | null; metadata: Record<string, unknown>; created_at: string };

export default function Audit() {
  const { data, error, loading } = useResource<{ entries: Entry[] }>("/console/audit?limit=300");
  return (
    <>
      <PageHeader title="Audit log" description="Who changed what — every console action and connector access is recorded." />
      <ErrorNote error={error} />
      {loading && !data ? (
        <Loading />
      ) : !data?.entries.length ? (
        <EmptyState icon={ScrollText} title="Nothing recorded yet" />
      ) : (
        <Card pad={false} className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-subtle">
              <tr>
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Target</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Details</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id} className="border-b border-border/60 last:border-0 hover:bg-chip/40">
                  <td className="px-4 py-2.5 whitespace-nowrap text-muted">{formatDate(e.created_at)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{e.action}</td>
                  <td className="px-4 py-2.5 text-muted">{e.target_type}</td>
                  <td className="hidden max-w-md truncate px-4 py-2.5 font-mono text-[11px] text-subtle md:table-cell">{JSON.stringify(e.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
