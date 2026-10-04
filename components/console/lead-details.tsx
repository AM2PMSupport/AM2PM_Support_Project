"use client";

/**
 * Console → Details: EVERY detail of the lead, editable in place.
 * Click a value to edit; text saves on Enter / leaving the field, dropdowns
 * save when picked, Esc cancels. One field per save (partial update via
 * lib/leads/edit.ts), so two people editing different fields don't clash.
 * Phone is editable only for roles that see full numbers; owner only for
 * roles that may reassign.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Loader2, Pencil, Plus } from "lucide-react";
import { processOwnersAction, updateLeadDetailsAction } from "@/app/(app)/console/actions";
import type { LeadDetail } from "@/lib/agent/queue";

type Editor = "text" | "email" | "tel" | "date" | "number" | "select";
interface Row {
  id: string; // what to send: name | phone | altPhone | email | campaign | ownerId | stage | custom:<key>
  label: string;
  value: string;
  display?: string;
  editor: Editor;
  options?: { value: string; label: string }[];
  editable: boolean;
  hint?: string;
}

const keyFromLabel = (l: string) => l.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export function LeadDetails({ lead, canEdit, canReassign, onSaved, onError }: { lead: LeadDetail; canEdit: boolean; canReassign: boolean; onSaved: (l: LeadDetail) => void; onError: (msg: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [owners, setOwners] = useState<{ id: string; name: string }[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    if (!canReassign) return;
    let live = true;
    processOwnersAction(lead.processId).then((r) => live && r.ok && setOwners(r.data ?? []));
    return () => {
      live = false;
    };
  }, [canReassign, lead.processId]);

  // Focus and select the current value, so typing replaces it.
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    if (inputRef.current instanceof HTMLInputElement) inputRef.current.select();
  }, [editing]);

  const str = (v: unknown) => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
  const defined = new Set(lead.fields.map((f) => f.key));
  const rows: Row[] = [
    { id: "name", label: "Name", value: lead.name, editor: "text", editable: canEdit },
    { id: "phone", label: "Mobile", value: lead.phone, editor: "tel", editable: canEdit && lead.phoneFull, hint: lead.phoneFull ? undefined : "Hidden for your role" },
    { id: "altPhone", label: "Mobile 2", value: lead.altPhone ?? "", editor: "tel", editable: canEdit && lead.phoneFull, hint: lead.phoneFull ? undefined : "Hidden for your role" },
    { id: "email", label: "Email", value: lead.email ?? "", editor: "email", editable: canEdit },
    { id: "campaign", label: "Campaign", value: lead.campaign ?? "", editor: "text", editable: canEdit },
    {
      id: "stage",
      label: "Stage",
      value: lead.stage,
      editor: "select",
      options: lead.stages.map((s) => ({ value: s, label: s })),
      editable: canEdit && lead.status === "open",
      hint: lead.status !== "open" ? `Lead is ${lead.status}` : undefined,
    },
    {
      id: "ownerId",
      label: "Lead owner",
      value: lead.ownerId ?? "",
      display: lead.owner ?? "Unassigned",
      editor: "select",
      options: [...(owners ?? []).map((o) => ({ value: o.id, label: o.name }))],
      editable: canReassign && !!owners?.length,
    },
    ...lead.fields.map<Row>((f) => ({
      id: `custom:${f.key}`,
      label: `${f.label}${f.required ? " *" : ""}`,
      value: f.type === "boolean" ? (lead.custom[f.key] === true ? "yes" : lead.custom[f.key] === false ? "no" : "") : str(lead.custom[f.key]),
      display: f.type === "boolean" ? (lead.custom[f.key] === true ? "Yes" : lead.custom[f.key] === false ? "No" : "") : undefined,
      editor: f.type === "dropdown" ? "select" : f.type === "boolean" ? "select" : f.type === "date" ? "date" : f.type === "number" ? "number" : "text",
      options: f.type === "dropdown" ? f.options.map((o) => ({ value: o, label: o })) : f.type === "boolean" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : undefined,
      editable: canEdit,
      hint: f.type === "multiselect" ? `Comma-separated: ${f.options.join(", ")}` : undefined,
    })),
    // Extra columns that came in with the lead (imports, forms) — editable as text.
    ...Object.entries(lead.custom)
      .filter(([k]) => !defined.has(k))
      .map<Row>(([k, v]) => ({ id: `custom:${k}`, label: k.replace(/_/g, " "), value: str(v), editor: "text", editable: canEdit })),
  ];

  function save(row: Row, value: string) {
    setEditing(null);
    if (value === row.value) return;
    const patch: Record<string, unknown> = { leadId: lead.id };
    if (row.id.startsWith("custom:")) patch.custom = { [row.id.slice(7)]: value };
    else patch[row.id] = value;
    setSavingId(row.id);
    startTransition(async () => {
      const r = await updateLeadDetailsAction(patch as Parameters<typeof updateLeadDetailsAction>[0]);
      setSavingId(null);
      if (!r.ok) return onError(r.error);
      if (r.data) onSaved(r.data);
      setSavedId(row.id);
      setTimeout(() => setSavedId((x) => (x === row.id ? null : x)), 1500);
    });
  }

  return (
    <section className="panel">
      <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
        <span className="eyebrow">Details</span>
        <span className="text-[11.5px] text-ink-4">{canEdit ? "Click a value to edit" : "Read only for your role"}</span>
      </div>
      <dl className="grid grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => {
          const isEditing = editing === row.id;
          const shown = row.display ?? row.value;
          return (
            <div key={row.id} className={`group relative border-r border-b border-rule px-4 py-3 xl:[&:nth-child(3n)]:border-r-0 ${row.editable && !isEditing ? "cursor-pointer hover:bg-paper/70" : ""}`} onClick={() => row.editable && !isEditing && (setEditing(row.id), setDraft(row.value))}>
              <dt className="flex items-center justify-between text-[11px] text-ink-3">
                <span className="truncate capitalize">{row.label}</span>
                {savingId === row.id ? <Loader2 size={12} className="animate-spin text-ink-4" /> : savedId === row.id ? <Check size={12} className="text-moss" /> : row.editable && <Pencil size={11} className="opacity-0 group-hover:opacity-60" />}
              </dt>
              <dd className="mt-0.5 min-h-[22px] text-[14px] font-medium">
                {isEditing ? (
                  row.editor === "select" ? (
                    <select
                      ref={(el) => {
                        inputRef.current = el;
                      }}
                      value={draft}
                      onChange={(e) => save(row, e.target.value)}
                      onBlur={() => setEditing(null)}
                      onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                      className="h-8 w-full rounded border border-ink bg-sheet px-1.5 text-[13px] outline-none"
                    >
                      {row.id === "ownerId" && !row.value && <option value="">Unassigned</option>}
                      {row.id.startsWith("custom:") && <option value="">—</option>}
                      {row.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input
                      ref={(el) => {
                        inputRef.current = el;
                      }}
                      type={row.editor === "number" ? "text" : row.editor}
                      inputMode={row.editor === "number" ? "decimal" : row.editor === "tel" ? "tel" : undefined}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => save(row, draft.trim())}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") save(row, draft.trim());
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className="h-8 w-full rounded border border-ink bg-sheet px-2 text-[13px] outline-none"
                    />
                  )
                ) : shown ? (
                  <span className={row.id === "phone" || row.id === "altPhone" ? "font-mono tnum" : ""}>{shown}</span>
                ) : (
                  <span className="text-ink-4">—</span>
                )}
              </dd>
              {row.hint && !isEditing && <p className="mt-0.5 text-[10.5px] text-ink-4">{row.hint}</p>}
            </div>
          );
        })}
        {canEdit && (
          <div className="border-r border-b border-rule px-4 py-3 xl:[&:nth-child(3n)]:border-r-0">
            {adding ? (
              <form
                className="flex flex-col gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const k = keyFromLabel(newLabel);
                  if (!k || !newValue.trim()) return;
                  save({ id: `custom:${k}`, label: newLabel, value: "", editor: "text", editable: true }, newValue.trim());
                  setAdding(false);
                  setNewLabel("");
                  setNewValue("");
                }}
              >
                <input autoFocus value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Detail name (e.g. Budget)" maxLength={40} className="h-7 rounded border border-rule px-2 text-[12.5px] outline-none focus:border-ink" />
                <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="Value" maxLength={500} className="h-7 rounded border border-rule px-2 text-[12.5px] outline-none focus:border-ink" />
                <div className="flex gap-1.5">
                  <button className="h-7 flex-1 rounded bg-ink text-[12px] font-semibold text-sheet">Add</button>
                  <button type="button" onClick={() => setAdding(false)} className="h-7 rounded px-2 text-[12px] text-ink-3">Cancel</button>
                </div>
              </form>
            ) : (
              <button onClick={() => setAdding(true)} className="flex h-full items-center gap-1.5 text-[12.5px] font-medium text-teal-ink hover:underline">
                <Plus size={13} /> Add a detail
              </button>
            )}
          </div>
        )}
      </dl>
    </section>
  );
}
