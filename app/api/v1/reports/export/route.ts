/**
 * GET /api/v1/reports/export?report=…&period=…&from=…&to=…&process=… — one
 * Reports table as CSV (API.md §3.8a). Needs Reports · X; same scope as the
 * screen (agents: their own numbers). Audited as `report.exported`.
 */
import { z } from "zod";
import { requirePermission } from "@/lib/auth/rbac";
import { badRequest } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { withTenant } from "@/lib/db/tenant";
import { writeAudit } from "@/lib/audit";
import { csvResponse, toCsv } from "@/lib/http/csv";
import { agentDays, callsReport, overviewReport, reportScope, sourcesReport } from "@/lib/reports/reports";
import { clockOf, duration, summariseAgents, timeIn } from "@/lib/reports/period";

const REPORTS = ["overview", "agents", "agent_days", "sources", "calls"] as const;
const pctCell = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "");
const rate = (v: number | null) => (v === null ? "" : (Math.round(v * 10) / 10).toString());

export const GET = v1(async (req, ctx) => {
  requirePermission(ctx, "reports", "X");
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const report = z.enum(REPORTS).safeParse(params.report);
  if (!report.success) throw badRequest(`report must be one of ${REPORTS.join(", ")}`, "invalid_query");
  const scope = await reportScope(ctx, params);
  const c = { ctx, ...scope };
  const tz = ctx.timezone;

  let head: string[];
  let rows: unknown[][];
  switch (report.data) {
    case "overview": {
      const o = await overviewReport(c);
      head = ["Day", "Leads in", "Won"];
      rows = o.trend.map((t) => [t.day, t.leadsIn, t.won]);
      break;
    }
    case "agents": {
      head = ["Agent", "Days active", "Dialled", "Connected", "Connect %", "Dialled / hour", "Connected / hour", "Avg first call", "Avg last call", "Inbound answered", "Inbound missed", "Talk time", "Avg talk", "Interested", "Callbacks set", "Not interested", "Won", "Conversion % (of connected)", "Callbacks due", "Called on time", "Callback compliance %"];
      rows = summariseAgents(await agentDays(c)).map((a) => [
        a.name, a.daysActive, a.dialled, a.connected, pctCell(a.connected, a.dialled), rate(a.dialledPerHour), rate(a.connectedPerHour), clockOf(a.avgFirstCallMin), clockOf(a.avgLastCallMin),
        a.inboundAnswered, a.inboundMissed, duration(a.talkSec), duration(a.avgTalkSec), a.interested, a.callbacksSet, a.notInterested, a.won, pctCell(a.won, a.connected), a.callbacksDue, a.callbacksOnTime, pctCell(a.callbacksOnTime, a.callbacksDue),
      ]);
      break;
    }
    case "agent_days": {
      head = ["Day", "Agent", "Login", "First call", "Last call", "Logout", "Dialled", "Connected", "Connect %", "Inbound answered", "Inbound missed", "Talk time", "Interested", "Callbacks set", "Won", "Callbacks due", "Called on time"];
      rows = (await agentDays(c)).map((d) => [
        d.day, d.name, timeIn(d.login, tz), timeIn(d.firstCall, tz), timeIn(d.lastCall, tz), timeIn(d.logout, tz), d.dialled, d.connected, pctCell(d.connected, d.dialled),
        d.inboundAnswered, d.inboundMissed, duration(d.talkSec), d.interested, d.callbacksSet, d.won, d.callbacksDue, d.callbacksOnTime,
      ]);
      break;
    }
    case "sources": {
      head = ["Source", "Leads", "Called", "Reached", "Reached %", "Interested", "Won", "Conversion %", "Lost", "Never called", "Median first call"];
      rows = (await sourcesReport(c)).map((s) => [s.source, s.leads, s.attempted, s.reached, pctCell(s.reached, s.leads), s.interested, s.won, pctCell(s.won, s.leads), s.lost, s.neverCalled, duration(s.medianFirstCallSec)]);
      break;
    }
    case "calls": {
      const k = await callsReport(c);
      head = ["Day", "Dialled", "Connected", "Connect %", "Inbound", "Talk time"];
      rows = k.byDay.map((d) => [d.day, d.dialled, d.connected, pctCell(d.connected, d.dialled), d.inbound, duration(d.talkSec)]);
      break;
    }
  }
  await withTenant(ctx, (tx) => writeAudit(tx, ctx, { action: "report.exported", entity: "report", after: { report: report.data, from: scope.range.from, to: scope.range.to, processId: scope.processId ?? null, rows: rows.length } }));
  return csvResponse(toCsv(head, rows), `${report.data}-${ctx.tenantSlug}-${scope.range.from}_${scope.range.to}.csv`);
});
