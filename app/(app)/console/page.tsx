/**
 * Console — the agent's live queue, lead workspace and timeline (T1.33–T1.35).
 * Server-renders the queue and the first lead; the client keeps them fresh.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
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
  if (wanted !== undefined && !isUuid(wanted)) notFound();
  const [{ queue, lead: first }, processes, options] = await Promise.all([getConsole(ctx, wanted ?? null), myProcesses(ctx), leadFilterOptions(ctx)]);
  // A lead link that isn't in this workspace or this person's scope → 404 (SECURITY.md §3.3),
  // the same as a lead that doesn't exist — never a silent jump to another lead.
  if (wanted && first?.id !== wanted) notFound();
  return (
    <div className="flex h-dvh flex-col">
      <Topbar title="Console" subtitle="Your queue · click-to-call rings your phone first" />
      <LiveConsole initialQueue={queue} initialLead={first} processes={processes} options={options} showOwners={leadScope(ctx.actor.role) !== "own"} canEdit={can(ctx.actor, "leads", "E")} canReassign={canReassign(ctx.actor)} dial={first && first.id === wanted && (dial === "primary" || dial === "alt") ? dial : undefined} />
    </div>
  );
}
