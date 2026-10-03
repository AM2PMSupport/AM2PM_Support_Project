/**
 * Leads — every lead in the signed-in role's scope (Zoho-style): filter
 * rail with saved filters, sort, list or board view, columns, bulk
 * reassign / stage, Create Lead and CSV export. URL params drive the query
 * (lib/leads/list.ts LeadQuery); the page, its filter options and the saved
 * filters load in parallel.
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { requirePage } from "@/lib/auth/guard";
import { LeadsWorkspace } from "@/components/leads/leads-workspace";
import { Topbar } from "@/components/shell/topbar";
import { LeadQuery, leadFilterOptions, listLeads } from "@/lib/leads/list";
import { listViews } from "@/lib/leads/views";
import { can, canReassign, leadScope } from "@/lib/auth/rbac";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

/** Request time, read once per server render (relative times are computed from it). */
const requestTime = () => Date.now();

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePage("leads");
  const raw = Object.fromEntries(Object.entries(await searchParams).filter((e): e is [string, string] => typeof e[1] === "string"));
  // A bad hand-edited URL falls back to the defaults instead of erroring.
  const query = LeadQuery.safeParse(raw).success ? raw : {};
  const role = ctx.actor.role;
  const renderedAt = requestTime();
  const [{ items, nextCursor, prevCursor, total }, options, views] = await Promise.all([listLeads(ctx, query), leadFilterOptions(ctx), listViews(ctx)]);

  return (
    // Fixed frame: page never scrolls; filter rail and table scroll inside, paging pinned at the bottom.
    <div className="flex h-dvh flex-col">
      <Topbar search={false} title="Leads" subtitle={`${role === "agent" ? "Your leads" : "All leads you can see"} · ${ctx.tenantName}`} />
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-3 pb-2 md:px-6">
        <Suspense>
          <LeadsWorkspace
            rows={items}
            total={total}
            nextCursor={nextCursor}
            prevCursor={prevCursor}
            options={options}
            views={views}
            renderedAt={renderedAt}
            can={{
              create: can(role, "leads", "C"),
              assign: canReassign(role),
              editStage: can(role, "leads", "E"),
              exportCsv: can(role, "leads", "X"),
              share: can(role, "config", "E"),
              seeOwners: leadScope(role) !== "own",
              delete: can(role, "leads", "D"),
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}
