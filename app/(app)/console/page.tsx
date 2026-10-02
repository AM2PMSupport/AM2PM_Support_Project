/**
 * Console — the agent's live queue, lead workspace and timeline (T1.33–T1.35).
 * Server-renders the queue and the first lead; the client keeps them fresh.
 */
import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/guard";
import { LiveConsole } from "@/components/console/live-console";
import { Topbar } from "@/components/shell/topbar";
import { getConsole } from "@/lib/agent/queue";
import { isUuid } from "@/lib/db/tenant";
import { can, canReassign } from "@/lib/auth/rbac";

export const metadata: Metadata = { title: "Console" };
export const dynamic = "force-dynamic";

export default async function ConsolePage({ searchParams }: { searchParams: Promise<{ lead?: string }> }) {
  const ctx = await requirePage("console");
  const { lead: wanted } = await searchParams;
  // Queue + open lead in one transaction (the notification-linked lead wins when in scope).
  const { queue, lead: first } = await getConsole(ctx, wanted && isUuid(wanted) ? wanted : null);
  return (
    <div className="flex h-dvh flex-col">
      <Topbar title="Console" subtitle="Your queue · click-to-call rings your phone first" />
      <LiveConsole initialQueue={queue} initialLead={first} canEdit={can(ctx.actor.role, "leads", "E")} canReassign={canReassign(ctx.actor.role)} />
    </div>
  );
}
