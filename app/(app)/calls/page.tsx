/**
 * Calls — the call log with recordings (T1.39): every call in the viewer's
 * scope with time (workspace timezone), direction, lead, agent, result,
 * duration, talk time and a player. Filters live in the URL; data comes from
 * lib/calls/list.ts on a read replica. "Sync now" pulls CallerDesk's call
 * report for calls whose webhooks never arrived.
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { requirePage } from "@/lib/auth/guard";
import { Topbar } from "@/components/shell/topbar";
import { CallsLog } from "@/components/calls/calls-log";
import { CallQuery, callTotals, listCalls } from "@/lib/calls/list";
import { lastSync } from "@/lib/telephony/sync";
import { can, leadScope } from "@/lib/auth/rbac";
import { leadFilterOptions } from "@/lib/leads/list";

export const metadata: Metadata = { title: "Calls" };
export const dynamic = "force-dynamic";

export default async function CallsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePage("calls");
  const raw = Object.fromEntries(Object.entries(await searchParams).filter((e): e is [string, string] => typeof e[1] === "string"));
  const query = CallQuery.safeParse(raw).success ? raw : {};
  const seeAgents = leadScope(ctx.actor.role) !== "own";
  const [page, totals, sync, options] = await Promise.all([
    listCalls(ctx, query),
    callTotals(ctx, query),
    lastSync(ctx.tenantId),
    seeAgents ? leadFilterOptions(ctx) : Promise.resolve(null),
  ]);
  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar title="Calls" subtitle={`${seeAgents ? "All calls you can see" : "Your calls"} · recordings, durations, results · ${ctx.tenantName}`} />
      <div className="px-6 py-5">
        <Suspense>
          <CallsLog
            rows={page.items}
            total={page.total}
            nextCursor={page.nextCursor}
            totals={totals}
            agents={options?.owners.map((o) => ({ id: o.id, name: o.name })) ?? []}
            canSync={can(ctx.actor.role, "config", "V")}
            lastSync={sync}
            timeZone={ctx.timezone}
          />
        </Suspense>
      </div>
    </div>
  );
}
