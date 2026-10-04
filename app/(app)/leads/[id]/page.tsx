/**
 * Lead record — full page (Leads → Edit). Every field editable in one place
 * (contact, stage, owner, campaign, custom fields and extra columns), every
 * system column read-only, plus the timeline and call history with
 * recordings (components/leads/lead-record.tsx). Scope and masking come from
 * the same loaders as the console (lib/agent/queue.ts getLeadDetail) and the
 * edit drawer it replaces (lib/leads/edit.ts getLeadForEdit); without
 * leads "E" the page is read-only.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/auth/rbac";
import { isUuid } from "@/lib/db/tenant";
import { getLeadDetail } from "@/lib/agent/queue";
import { getLeadForEdit } from "@/lib/leads/edit";
import { leadFilterOptions } from "@/lib/leads/list";
import { ApiError } from "@/lib/http/errors";
import { Topbar } from "@/components/shell/topbar";
import { LeadRecord } from "@/components/leads/lead-record";

export const metadata: Metadata = { title: "Lead" };
export const dynamic = "force-dynamic";

export default async function LeadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ back?: string }> }) {
  const ctx = await requirePage("leads");
  const { id } = await params;
  // The Leads list's query (page, filters, sort) to return to. Re-encoded so it can only ever be a /leads query string.
  const back = new URLSearchParams((await searchParams).back ?? "").toString();
  if (!isUuid(id)) notFound();
  const canEdit = can(ctx.actor, "leads", "E");
  // Out of scope or deleted → 404 (same answer either way: no existence leak).
  const [detail, edit, options] = await Promise.all([
    getLeadDetail(ctx, id),
    canEdit ? getLeadForEdit(ctx, id) : Promise.resolve(null),
    canEdit ? leadFilterOptions(ctx) : Promise.resolve(null),
  ]).catch((err) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  return (
    <div className="flex h-dvh flex-col">
      <Topbar search={false} title="Lead" subtitle={`${detail.name} · ${detail.processName}`} />
      <LeadRecord detail={detail} edit={edit} owners={options?.owners ?? []} timeZone={ctx.timezone} backHref={back ? `/leads?${back}` : "/leads"} />
    </div>
  );
}
