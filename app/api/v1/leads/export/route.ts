/**
 * GET /api/v1/leads/export — the current Leads filter as CSV (max 10,000
 * rows). Needs the leads "X" (export) permission; phones stay masked for
 * roles that may not see full numbers. Audited. API.md §3.8.
 */
import { requirePermission } from "@/lib/auth/rbac";
import { badRequest } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { exportLeads, LeadQuery } from "@/lib/leads/list";
import { withTenant } from "@/lib/db/tenant";
import { writeAudit } from "@/lib/audit";
import { csvResponse, toCsv } from "@/lib/http/csv";

export const GET = v1(async (req, ctx) => {
  requirePermission(ctx, "leads", "X");
  const params = Object.fromEntries(new URL(req.url).searchParams);
  if (!LeadQuery.safeParse(params).success) throw badRequest("Invalid query", "invalid_query");
  const rows = await exportLeads(ctx, params);
  await withTenant(ctx, (tx) => writeAudit(tx, ctx, { action: "leads.exported", entity: "lead", entityId: ctx.actor.userId, after: { rows: rows.length, filter: params } }));
  const head = ["Name", "Phone", "Email", "Process", "Source", "Campaign", "Stage", "Status", "Owner", "Last outcome", "Attempts", "Next callback", "Created"];
  const body = toCsv(head, rows.map((r) => [r.name, r.phone, r.email, r.processName, r.source, r.campaign, r.stage, r.status, r.owner, r.lastDisposition, r.attempts, r.nextCallbackAt, r.createdAt]));
  return csvResponse(body, `leads-${ctx.tenantSlug}-${new Date().toISOString().slice(0, 10)}.csv`);
});
