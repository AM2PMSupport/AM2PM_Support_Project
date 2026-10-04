/**
 * Console — the agent's live queue, lead workspace and timeline (T1.33–T1.35).
 * Server-renders the queue and the first lead; the client keeps them fresh.
 */
import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/guard";
import { LiveConsole } from "@/components/console/live-console";
import { Topbar } from "@/components/shell/topbar";
import { getConsole, myProcesses } from "@/lib/agent/queue";
import { isUuid } from "@/lib/db/tenant";
import { can, canReassign, leadScope } from "@/lib/auth/rbac";
import { leadFilterOptions } from "@/lib/leads/list";

export const metadata: Metadata = { title: "Console" };
export const dynamic = "force-dynamic";

export default async function ConsolePage({ searchParams }: { searchParams: Promise<{ lead?: string; dial?: string }> }) {
  const ctx = await requirePage("console");
  const { lead: wanted, dial } = await searchParams;
  // Queue + open lead in one transaction (the notification-linked lead wins when in scope).
  const [{ queue, lead: first }, processes, options] = await Promise.all([getConsole(ctx, wanted && isUuid(wanted) ? wanted : null), myProcesses(ctx), leadFilterOptions(ctx)]);
  return (
    <div className="flex h-dvh flex-col">
      <Topbar title="Console" subtitle="Your queue · click-to-call rings your phone first" />
      <LiveConsole initialQueue={queue} initialLead={first} processes={processes} options={options} showOwners={leadScope(ctx.actor.role) !== "own"} canEdit={can(ctx.actor.role, "leads", "E")} canReassign={canReassign(ctx.actor.role)} dial={first && first.id === wanted && (dial === "primary" || dial === "alt") ? dial : undefined} />
    </div>
  );
}
