/**
 * Manager digest email — pure rendering, no I/O (T1.42, PRD FR-32,
 * ARCHITECTURE.md cron table: "hot leads, follow-ups due, disposition counts").
 * Data comes from lib/platform-admin/digest.ts; this only turns it into a
 * subject, a small inline-styled HTML email (mail clients ignore <style>) and
 * a plain-text twin. Every value is escaped — lead names are customer input.
 */
export interface DigestData {
  workspace: string;
  recipient: string;
  /** Yesterday, tenant-local yyyy-mm-dd. */
  day: string;
  scope: string;
  yesterday: { leadsIn: number; reached: number; won: number; lost: number; dialled: number; connected: number; callbacksDue: number; callbacksOnTime: number };
  today: { callbacksDue: number; overdue: number; unassigned: number; neverCalled: number };
  outcomes: { label: string; count: number }[];
  hotLeads: { name: string; owner: string | null; stage: string; nextCallback: string | null }[];
  url: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const dayText = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

export function renderDigest(d: DigestData): { subject: string; html: string; text: string } {
  const y = d.yesterday;
  const t = d.today;
  const alerts = [t.overdue && `${t.overdue} overdue callback${t.overdue === 1 ? "" : "s"}`, t.unassigned && `${t.unassigned} unassigned`].filter(Boolean).join(" · ");
  const subject = `${d.workspace} · ${dayText(d.day)}: ${y.leadsIn} leads, ${y.won} won${alerts ? ` · ${alerts}` : ""}`;

  const kpi = (label: string, value: string, note = "") =>
    `<td style="padding:10px 12px;border:1px solid #e4e1d9;vertical-align:top"><div style="font-size:11px;color:#6b6f78;text-transform:uppercase;letter-spacing:.04em">${esc(label)}</div><div style="font-size:22px;font-weight:700;color:#15171c;margin-top:4px">${esc(value)}</div>${note ? `<div style="font-size:11px;color:#8a8e96;margin-top:2px">${esc(note)}</div>` : ""}</td>`;
  const row = (cells: string[]) => `<tr>${cells.map((c) => `<td style="padding:6px 8px;border-bottom:1px solid #eeebe4;font-size:13px">${c}</td>`).join("")}</tr>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f5f3ee;font-family:Arial,Helvetica,sans-serif;color:#15171c">
<div style="max-width:620px;margin:0 auto;padding:20px">
<div style="font-size:12px;color:#6b6f78">AM2PM CRM · ${esc(d.workspace)} · ${esc(d.scope)}</div>
<h1 style="font-size:20px;margin:6px 0 2px">Good morning, ${esc(d.recipient)}</h1>
<div style="font-size:13px;color:#6b6f78;margin-bottom:14px">Yesterday (${esc(dayText(d.day))}) and what needs you today.</div>
<table style="border-collapse:collapse;width:100%;background:#fff"><tr>${kpi("Leads in", String(y.leadsIn), `${pct(y.reached, y.leadsIn)} reached`)}${kpi("Won", String(y.won), `${y.lost} lost`)}${kpi("Calls", String(y.dialled), `${pct(y.connected, y.dialled)} connected`)}${kpi("Callbacks on time", pct(y.callbacksOnTime, y.callbacksDue), `${y.callbacksOnTime} of ${y.callbacksDue}`)}</tr></table>
<h2 style="font-size:14px;margin:18px 0 6px">Today</h2>
<table style="border-collapse:collapse;width:100%;background:#fff"><tr>${kpi("Callbacks due", String(t.callbacksDue))}${kpi("Overdue now", String(t.overdue))}${kpi("Unassigned", String(t.unassigned))}${kpi("Never called", String(t.neverCalled), "open leads")}</tr></table>
${d.hotLeads.length ? `<h2 style="font-size:14px;margin:18px 0 6px">Hot leads (interested, still open)</h2><table style="border-collapse:collapse;width:100%;background:#fff">${row(["<b>Lead</b>", "<b>Stage</b>", "<b>Owner</b>", "<b>Next callback</b>"])}${d.hotLeads.map((h) => row([esc(h.name), esc(h.stage), esc(h.owner ?? "Unassigned"), esc(h.nextCallback ?? "—")])).join("")}</table>` : ""}
${d.outcomes.length ? `<h2 style="font-size:14px;margin:18px 0 6px">Yesterday's outcomes</h2><table style="border-collapse:collapse;width:100%;background:#fff">${d.outcomes.map((o) => row([esc(o.label), `<b>${o.count}</b>`])).join("")}</table>` : ""}
<p style="margin:20px 0"><a href="${esc(d.url)}/reports?period=yesterday" style="background:#15171c;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:13px;font-weight:700">Open Reports</a> &nbsp; <a href="${esc(d.url)}/dashboard" style="color:#0f7c86;font-size:13px">Floor</a></p>
<div style="font-size:11px;color:#8a8e96">Sent daily at 09:00 to managers, supervisors and admins of this workspace.</div>
</div></body></html>`;

  const text = [
    `AM2PM CRM · ${d.workspace} · ${d.scope}`,
    `Good morning, ${d.recipient}. Yesterday (${dayText(d.day)}):`,
    `  Leads in ${y.leadsIn} (${pct(y.reached, y.leadsIn)} reached) · Won ${y.won} · Lost ${y.lost}`,
    `  Calls ${y.dialled} (${pct(y.connected, y.dialled)} connected) · Callbacks on time ${pct(y.callbacksOnTime, y.callbacksDue)} (${y.callbacksOnTime}/${y.callbacksDue})`,
    `Today: ${t.callbacksDue} callbacks due · ${t.overdue} overdue · ${t.unassigned} unassigned · ${t.neverCalled} never called`,
    ...(d.hotLeads.length ? ["Hot leads:", ...d.hotLeads.map((h) => `  - ${h.name} (${h.stage}) · ${h.owner ?? "Unassigned"} · ${h.nextCallback ?? "no callback"}`)] : []),
    ...(d.outcomes.length ? ["Yesterday's outcomes:", ...d.outcomes.map((o) => `  - ${o.label}: ${o.count}`)] : []),
    `Reports: ${d.url}/reports?period=yesterday`,
  ].join("\n");

  return { subject, html, text };
}
