"use client";

/**
 * Full-page lead record (Leads → Edit, /leads/{id}). Left: everything about
 * the lead in one form — contact (name, Mobile 1/2, email), stage, owner,
 * campaign, every custom field the process defines plus extra columns that
 * came with the lead (imports, forms) — and a read-only block with every
 * system column (process, source, status, attempts, last outcome, callback,
 * activity, dates). Right: the lead's timeline and call history with
 * recordings.
 *
 * Saving goes through updateLeadAction (lib/leads/edit.ts updateLead), which
 * re-checks permission, scope, phone visibility and dedupe on the server.
 * Without leads "E" the page is read-only. Phones stay masked by role.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Pause, Phone, Play, X } from "lucide-react";
import { updateLeadAction } from "@/app/(app)/leads/actions";
import { ErrorNote, Field, Input, Select } from "@/components/ui/form";
import { StageTag, Tag } from "@/components/ui/primitives";
import { LeadTimeline } from "@/components/console/lead-timeline";
import { SOURCE_LABEL } from "@/components/leads/meta";
import type { LeadDetail } from "@/lib/agent/queue";
import type { LeadForEdit } from "@/lib/leads/edit";

type Form = { name: string; phone: string; altPhone: string; email: string; campaign: string; stage: string; ownerId: string; custom: Record<string, string> };

const toForm = (e: LeadForEdit): Form => ({ name: e.name, phone: e.phone, altPhone: e.altPhone, email: e.email, campaign: e.campaign, stage: e.stage, ownerId: e.ownerId ?? "", custom: { ...e.custom } });
const mmss = (s: number | null) => (s == null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
const statusTone = (s: string) => (s === "won" ? "moss" : s === "lost" || s === "dnc" ? "ember" : "muted");

/** `backHref` = the Leads list page the person came from (page, filters, sort kept). */
export function LeadRecord({ detail, edit, owners, timeZone, backHref }: { detail: LeadDetail; edit: LeadForEdit | null; owners: { id: string; name: string }[]; timeZone: string; backHref: string }) {
  const router = useRouter();
  const [form, setForm] = useState<Form | null>(edit ? toForm(edit) : null);
  // A save refreshes the page with a new `edit`: adopt it as the baseline (render-time sync, no effect).
  const [base, setBase] = useState(edit);
  if (edit !== base) {
    setBase(edit);
    setForm(edit ? toForm(edit) : null);
  }
  const [newLabel, setNewLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, startTransition] = useTransition();
  const [tab, setTab] = useState<"timeline" | "calls">("timeline");
  const [now, setNow] = useState(0);
  useEffect(() => {
    // Client clock only (avoids a hydration mismatch on relative times).
    const t = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(t);
  }, []);

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }) : null);
  const set = (patch: Partial<Form>) => (setSaved(false), setForm((f) => (f ? { ...f, ...patch } : f)));
  const dirty = !!edit && !!form && JSON.stringify(form) !== JSON.stringify(toForm(edit));

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit || !form) return;
    setError(null);
    startTransition(async () => {
      const r = await updateLeadAction({
        leadId: edit.id,
        name: form.name,
        phone: edit.canEditPhone ? form.phone : undefined,
        altPhone: edit.canEditPhone ? form.altPhone : undefined,
        email: form.email,
        campaign: form.campaign,
        stage: form.stage,
        ownerId: edit.canChangeOwner && form.ownerId ? form.ownerId : undefined,
        // Every detail: defined fields + extra columns (empty = remove).
        custom: Object.fromEntries([...new Set([...edit.fields.map((f) => f.key), ...Object.keys(edit.custom), ...Object.keys(form.custom)])].map((k) => [k, form.custom[k] ?? ""])),
      });
      if (!r.ok) return setError(r.error);
      setSaved(true);
      router.refresh();
    });
  }


  const system: [string, React.ReactNode][] = [
    ["Process", detail.processName],
    ["Source", <Tag key="s">{SOURCE_LABEL[detail.source] ?? detail.source}</Tag>],
    ["Status", <Tag key="st" tone={statusTone(detail.status)}>{detail.status === "dnc" ? "DNC" : detail.status[0]!.toUpperCase() + detail.status.slice(1)}</Tag>],
    ["Stage", <StageTag key="sg" stage={detail.stage} />],
    ["Lead owner", detail.owner ?? <span className="text-ember-ink">Unassigned</span>],
    ["Assigned", when(detail.assignedAt)],
    ["Attempts", <span key="a" className="font-mono tnum">{detail.attempts}</span>],
    ["Last outcome", detail.lastDisposition],
    ["Next callback", when(detail.nextCallbackAt)],
    ["Last activity", when(detail.lastActivityAt)],
    ["Last enquiry", when(detail.lastEnquiryAt)],
    ["Converted", when(detail.convertedAt)],
    ["Created", when(detail.createdAt)],
    ["Do not call", detail.dnc ? <span key="d" className="font-semibold text-ember-ink">Yes</span> : "No"],
  ];

  // Read-only view of custom data (no edit right): defined fields, then extra columns.
  const customRead = [
    ...detail.fields.map((f) => [f.label, detail.custom[f.key]] as const),
    ...Object.entries(detail.custom).filter(([k]) => !detail.fields.some((f) => f.key === k)).map(([k, v]) => [k.replace(/_/g, " "), v] as const),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Record header */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-rule px-4 py-3 md:px-6">
        <Link href={backHref} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-ink-3 hover:bg-paper hover:text-ink">
          <ArrowLeft size={14} /> Leads
        </Link>
        <div className="min-w-0">
          <div className="eyebrow">{detail.processName}</div>
          <h2 className="truncate text-[18px] font-semibold tracking-tight">{detail.name}</h2>
        </div>
        <StageTag stage={detail.stage} />
        <span className="font-mono text-[12.5px] text-ink-3 tnum">{detail.phone}{detail.altPhone ? ` · ${detail.altPhone}` : ""}</span>
        <div className="ml-auto flex items-center gap-2">
          {saved && !dirty && <span className="text-[12px] text-moss">Saved</span>}
          {detail.status === "open" && !detail.dnc && (
            <Link href={`/console?lead=${detail.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule bg-sheet px-3 text-[12.5px] font-medium text-ink-2 hover:border-ink-3" title="Open in the console to call">
              <Phone size={13} /> Call in console
            </Link>
          )}
          {edit && (
            <button form="lead-form" disabled={busy || !dirty} className="h-9 rounded-md bg-ink px-4 text-[12.5px] font-semibold text-sheet hover:bg-ink-2 disabled:bg-rule-strong disabled:text-ink-3">
              {busy ? "Saving…" : "Save changes"}
            </button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_440px]">
        {/* Left: all fields */}
        <div className="min-h-0 overflow-y-auto px-4 py-5 md:px-6">
          <div className="mx-auto flex max-w-[920px] flex-col gap-5">
            <ErrorNote message={error} />
            {edit && form ? (
              <form id="lead-form" onSubmit={save} className="flex flex-col gap-5">
                <section className="panel p-5">
                  <div className="eyebrow mb-3">Contact</div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Field label="Name"><Input value={form.name} onChange={(e) => set({ name: e.target.value })} required maxLength={120} /></Field>
                    <Field label="Email"><Input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} maxLength={254} /></Field>
                    <Field label="Mobile" hint={edit.canEditPhone ? "10-digit Indian mobile; +91 optional" : "Hidden for your role — ask a manager to change it"}>
                      <Input value={form.phone} onChange={(e) => set({ phone: e.target.value })} disabled={!edit.canEditPhone} inputMode="tel" maxLength={20} />
                    </Field>
                    <Field label="Mobile 2" hint={edit.canEditPhone ? "Optional second number — leave empty to remove" : undefined}>
                      <Input value={form.altPhone} onChange={(e) => set({ altPhone: e.target.value })} disabled={!edit.canEditPhone} inputMode="tel" maxLength={20} placeholder="—" />
                    </Field>
                  </div>
                </section>

                <section className="panel p-5">
                  <div className="eyebrow mb-3">Lead</div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <Field label="Stage" hint={edit.status !== "open" ? `Lead is ${edit.status}` : undefined}>
                      <Select value={form.stage} onChange={(e) => set({ stage: e.target.value })} disabled={edit.status !== "open"}>
                        {edit.stages.map((s) => <option key={s} value={s}>{s}</option>)}
                      </Select>
                    </Field>
                    <Field label="Lead owner" hint={edit.canChangeOwner ? undefined : "Your role can't reassign"}>
                      <Select value={form.ownerId} onChange={(e) => set({ ownerId: e.target.value })} disabled={!edit.canChangeOwner}>
                        <option value="">{edit.ownerId ? "—" : "Unassigned"}</option>
                        {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="Campaign"><Input value={form.campaign} onChange={(e) => set({ campaign: e.target.value })} maxLength={120} /></Field>
                  </div>
                </section>

                <section className="panel p-5">
                  <div className="eyebrow mb-3">Details · custom fields</div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {edit.fields.map((f) => (
                      <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`} hint={f.type === "multiselect" ? `Comma-separated: ${f.options.join(", ")}` : undefined}>
                        {f.type === "dropdown" || f.type === "boolean" ? (
                          <Select value={f.type === "boolean" ? ({ true: "yes", false: "no" } as Record<string, string>)[form.custom[f.key] ?? ""] ?? form.custom[f.key] ?? "" : form.custom[f.key] ?? ""} onChange={(e) => set({ custom: { ...form.custom, [f.key]: e.target.value } })}>
                            <option value="">—</option>
                            {(f.type === "boolean" ? ["yes", "no"] : f.options).map((o) => <option key={o} value={o}>{f.type === "boolean" ? (o === "yes" ? "Yes" : "No") : o}</option>)}
                          </Select>
                        ) : (
                          <Input
                            type={f.type === "date" ? "date" : "text"}
                            inputMode={f.type === "number" ? "decimal" : undefined}
                            value={form.custom[f.key] ?? ""}
                            onChange={(e) => set({ custom: { ...form.custom, [f.key]: e.target.value } })}
                          />
                        )}
                      </Field>
                    ))}
                    {/* Extra columns that came with the lead (imports, forms). */}
                    {Object.keys(form.custom)
                      .filter((k) => !edit.fields.some((f) => f.key === k))
                      .map((k) => (
                        <Field key={k} label={k.replace(/_/g, " ")}>
                          <div className="flex gap-2">
                            <Input value={form.custom[k] ?? ""} onChange={(e) => set({ custom: { ...form.custom, [k]: e.target.value } })} maxLength={500} />
                            <button type="button" onClick={() => set({ custom: { ...form.custom, [k]: "" } })} title="Clear" className="rounded px-2 text-ink-3 hover:bg-paper hover:text-ink"><X size={14} /></button>
                          </div>
                        </Field>
                      ))}
                  </div>
                  {!edit.fields.length && !Object.keys(form.custom).length && <p className="text-[12.5px] text-ink-4">No custom fields for this process yet (Setup → Outcomes & fields).</p>}
                  <div className="mt-4 flex max-w-[460px] gap-2">
                    <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Add a detail (e.g. Budget)" maxLength={40} />
                    <button
                      type="button"
                      disabled={!newLabel.trim()}
                      onClick={() => {
                        const k = newLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
                        if (k && !(k in form.custom)) set({ custom: { ...form.custom, [k]: "" } });
                        setNewLabel("");
                      }}
                      className="h-9 shrink-0 rounded-md border border-rule px-3 text-[12.5px] font-medium text-ink-2 hover:border-ink-3 disabled:opacity-40"
                    >
                      Add
                    </button>
                  </div>
                </section>
              </form>
            ) : (
              <section className="panel p-5">
                <div className="eyebrow mb-3">Contact & details</div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[13px] md:grid-cols-2">
                  {([["Name", detail.name], ["Email", detail.email], ["Mobile", detail.phone], ["Mobile 2", detail.altPhone], ["Campaign", detail.campaign], ...customRead] as [string, unknown][]).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-[11.5px] text-ink-3 capitalize">{k}</dt>
                      <dd className="mt-0.5">{v == null || v === "" ? <span className="text-ink-4">—</span> : Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            <section className="panel p-5">
              <div className="eyebrow mb-3">System fields</div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] md:grid-cols-3 xl:grid-cols-4">
                {system.map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-[11.5px] text-ink-3">{k}</dt>
                    <dd className="mt-0.5 truncate">{v ?? <span className="text-ink-4">—</span>}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        </div>

        {/* Right: timeline + call history */}
        <aside className="flex min-h-0 flex-col border-t border-rule bg-sheet lg:border-t-0 lg:border-l">
          <div className="flex shrink-0 gap-1 border-b border-rule p-2">
            {(["timeline", "calls"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[5px] text-[12.5px] font-medium ${tab === t ? "bg-ink text-sheet" : "text-ink-3 hover:bg-paper hover:text-ink"}`}>
                {t === "timeline" ? "Timeline" : "Call history"}
                <span className={`font-mono text-[11px] ${tab === t ? "text-teal" : "text-ink-4"}`}>{t === "timeline" ? detail.timeline.length : detail.calls.length}</span>
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {tab === "timeline" ? <LeadTimeline items={detail.timeline} now={now} /> : <CallHistory calls={detail.calls} when={when} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function CallHistory({ calls, when }: { calls: LeadDetail["calls"]; when: (iso: string | null) => string | null }) {
  const [playing, setPlaying] = useState<string | null>(null);
  if (!calls.length) return <p className="text-[12.5px] text-ink-4">No calls yet.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {calls.map((c) => {
        const open = playing === c.id;
        const bad = c.status === "missed" || c.status === "failed" || c.status === "not_connected";
        return (
          <li key={c.id} className={`rounded-md border border-rule px-3 py-2.5 ${open ? "bg-paper" : ""}`}>
            <div className="flex items-center gap-3">
              {c.hasRecording ? (
                <button onClick={() => setPlaying(open ? null : c.id)} aria-label={open ? "Close player" : "Play recording"} className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${open ? "bg-ink text-sheet" : "bg-teal/25 text-ink hover:bg-teal/45"}`}>
                  {open ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
                </button>
              ) : (
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-ink-4" title="No recording">
                  {c.direction === "inbound" ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <span className="font-semibold">{c.direction === "inbound" ? "Inbound" : "Outbound"}</span>
                  <Tag tone={bad ? "ember" : c.status === "completed" || c.status === "answered" ? "teal" : "muted"}>{c.status.replace(/_/g, " ")}</Tag>
                </div>
                <div className="mt-0.5 truncate text-[11.5px] text-ink-3">
                  {when(c.startedAt)}{c.agentName ? ` · ${c.agentName}` : ""}
                </div>
              </div>
              <div className="text-right font-mono text-[11.5px] tnum">
                <div>{mmss(c.durationSec)}</div>
                <div className="text-ink-4">talk {mmss(c.talkSec)}</div>
              </div>
            </div>
            {(c.outcome || c.notes) && <div className="mt-1.5 pl-11 text-[12px] text-ink-2">{c.outcome && <span className="font-medium">{c.outcome}</span>}{c.outcome && c.notes ? " · " : ""}{c.notes}</div>}
            {open && (
              <audio controls autoPlay preload="none" src={`/api/v1/calls/${c.id}/recording`} className="mt-2 h-10 w-full">
                Your browser can’t play this recording.
              </audio>
            )}
          </li>
        );
      })}
    </ul>
  );
}
