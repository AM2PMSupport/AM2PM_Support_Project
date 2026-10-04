"use client";

/**
 * Edit lead drawer: contact details, stage, owner and the process's custom
 * fields. Phone is editable only for roles that see full numbers; owner only
 * for roles that may reassign. Validation messages come from the server.
 */
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { X } from "lucide-react";
import { leadForEditAction, updateLeadAction } from "@/app/(app)/leads/actions";
import { ErrorNote, Field, Input, Select } from "@/components/ui/form";
import type { LeadForEdit } from "@/lib/leads/edit";
import { Portal } from "@/components/ui/portal";

export function EditLead({ leadId, owners, onClose, onSaved }: { leadId: string; owners: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [lead, setLead] = useState<LeadForEdit | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; phone: string; altPhone: string; email: string; campaign: string; stage: string; ownerId: string; custom: Record<string, string> } | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    leadForEditAction(leadId).then((r) => {
      if (!live) return;
      if (!r.ok || !r.data) return setLoadError(r.ok ? "Lead not found" : r.error);
      setLead(r.data);
      setForm({ name: r.data.name, phone: r.data.phone, altPhone: r.data.altPhone, email: r.data.email, campaign: r.data.campaign, stage: r.data.stage, ownerId: r.data.ownerId ?? "", custom: { ...r.data.custom } });
    });
    return () => {
      live = false;
    };
  }, [leadId]);

  const set = (patch: Partial<NonNullable<typeof form>>) => setForm((f) => (f ? { ...f, ...patch } : f));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!lead || !form) return;
    setError(null);
    startTransition(async () => {
      const r = await updateLeadAction({
        leadId: lead.id,
        name: form.name,
        phone: lead.canEditPhone ? form.phone : undefined,
        altPhone: lead.canEditPhone ? form.altPhone : undefined,
        email: form.email,
        campaign: form.campaign,
        stage: form.stage,
        ownerId: lead.canChangeOwner && form.ownerId ? form.ownerId : undefined,
        // Every detail: defined fields + extra columns (empty = remove).
        custom: Object.fromEntries([...new Set([...lead.fields.map((f) => f.key), ...Object.keys(lead.custom), ...Object.keys(form.custom)])].map((k) => [k, form.custom[k] ?? ""])),
      });
      if (!r.ok) return setError(r.error);
      onSaved();
      onClose();
    });
  }

  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/25" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Edit lead" className="flex h-full w-[460px] flex-col bg-sheet shadow-[-20px_0_60px_-20px_rgba(21,23,28,0.35)]">
        <header className="flex items-center justify-between border-b border-rule px-5 py-4">
          <div className="min-w-0">
            <div className="eyebrow">{lead?.processName ?? "Lead"}</div>
            <h2 className="truncate text-[16px] font-semibold">Edit {lead?.name || "lead"}</h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded p-1.5 text-ink-3 hover:bg-paper hover:text-ink"><X size={16} /></button>
        </header>

        {loadError && <div className="p-5"><ErrorNote message={loadError} /></div>}
        {!lead && !loadError && <div className="flex flex-col gap-3 p-5">{[1, 2, 3, 4].map((i) => <span key={i} className="skeleton h-10 w-full" />)}</div>}

        {lead && form && (
          <form onSubmit={submit} className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
            <Field label="Name"><Input value={form.name} onChange={(e) => set({ name: e.target.value })} required maxLength={120} autoFocus /></Field>
            <Field label="Mobile" hint={lead.canEditPhone ? "10-digit Indian mobile; +91 optional" : "Hidden for your role — ask a manager to change it"}>
              <Input value={form.phone} onChange={(e) => set({ phone: e.target.value })} disabled={!lead.canEditPhone} inputMode="tel" maxLength={20} />
            </Field>
            <Field label="Mobile 2" hint={lead.canEditPhone ? "Optional second number — leave empty to remove" : undefined}>
              <Input value={form.altPhone} onChange={(e) => set({ altPhone: e.target.value })} disabled={!lead.canEditPhone} inputMode="tel" maxLength={20} placeholder="—" />
            </Field>
            <Field label="Email"><Input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} maxLength={254} /></Field>
            <Field label="Campaign" hint={`Source: ${lead.source.replace(/_/g, " ")}`}><Input value={form.campaign} onChange={(e) => set({ campaign: e.target.value })} maxLength={120} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Stage" hint={lead.status !== "open" ? `Lead is ${lead.status}` : undefined}>
                <Select value={form.stage} onChange={(e) => set({ stage: e.target.value })} disabled={lead.status !== "open"}>
                  {lead.stages.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </Field>
              <Field label="Lead owner">
                <Select value={form.ownerId} onChange={(e) => set({ ownerId: e.target.value })} disabled={!lead.canChangeOwner}>
                  <option value="">{lead.ownerId ? "—" : "Unassigned"}</option>
                  {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              </Field>
            </div>

            <div className="flex flex-col gap-3 border-t border-rule pt-4">
              <div className="eyebrow">Details</div>
              {lead.fields.map((f) => (
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
                .filter((k) => !lead.fields.some((f) => f.key === k))
                .map((k) => (
                  <Field key={k} label={k.replace(/_/g, " ")}>
                    <div className="flex gap-2">
                      <Input value={form.custom[k] ?? ""} onChange={(e) => set({ custom: { ...form.custom, [k]: e.target.value } })} maxLength={500} />
                      <button type="button" onClick={() => set({ custom: { ...form.custom, [k]: "" } })} title="Clear" className="rounded px-2 text-ink-3 hover:bg-paper hover:text-ink"><X size={14} /></button>
                    </div>
                  </Field>
                ))}
              <div className="flex gap-2">
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
            </div>

            <ErrorNote message={error} />
            <div className="mt-auto flex items-center gap-2 border-t border-rule pt-4">
              <button disabled={busy} className="h-9 flex-1 rounded-md bg-ink text-[13px] font-semibold text-sheet hover:bg-ink-2 disabled:bg-ink-4">{busy ? "Saving…" : "Save changes"}</button>
              <Link href={`/console?lead=${lead.id}`} className="inline-flex h-9 items-center rounded-md border border-rule px-3 text-[13px] font-medium text-ink-2 hover:border-ink-3">Open</Link>
              <button type="button" onClick={onClose} className="h-9 rounded-md border border-rule px-3 text-[13px] font-medium text-ink-2 hover:border-ink-3">Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
    </Portal>
  );
}
