"use client";

/**
 * Console → Details: every field of the lead, in the SECTIONS and ORDER of
 * Setup → Lead layout (lead.layout, lib/leads/layout.ts), editable in place.
 * Click a value to edit; text saves on Enter / leaving the field, pick lists
 * save when picked, Esc cancels. One field per save (partial update via
 * lib/leads/edit.ts), so two people editing different fields don't clash.
 * Phone is editable only for roles that see full numbers; owner only for
 * roles that may reassign; system dates and counts are read-only. Extra
 * columns that came with the lead (imports, forms) follow in "Other details".
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Loader2, Pencil, Plus } from "lucide-react";
import { processOwnersAction, updateLeadDetailsAction } from "@/app/(app)/console/actions";
import type { LeadDetail } from "@/lib/agent/queue";
import type { FieldDef } from "@/lib/leads/layout";
import { SOURCE_LABEL } from "@/components/leads/meta";
import { FieldInput, formatValue, toFormValue } from "@/components/leads/field-input";

type Editor = "text" | "email" | "tel" | "select" | "custom";
interface Row {
  id: string; // what to send: name | phone | altPhone | email | campaign | ownerId | stage | custom:<key> | ro:<key>
  label: string;
  value: string;
  display?: string;
  editor: Editor;
  options?: { value: string; label: string }[];
  def?: FieldDef;
  editable: boolean;
  hint?: string;
  mono?: boolean;
}

const keyFromLabel = (l: string) => l.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

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

  const ro = (id: string, label: string, display: string, mono = false): Row => ({ id: `ro:${id}`, label, value: display, editor: "text", editable: false, mono });
  const statusText = lead.status === "dnc" ? "DNC" : lead.status[0]!.toUpperCase() + lead.status.slice(1);

  /** One layout field → a row. */
  function rowOf(f: LeadDetail["layout"][number]["fields"][number]): Row {
    if (f.kind === "cf") {
      const v = lead.custom[f.key];
      return { id: `custom:${f.key}`, label: `${f.label}${f.def.required ? " *" : ""}`, value: toFormValue(f.def, v), display: formatValue(f.def, v, lead.people), editor: "custom", def: f.def, editable: canEdit };
    }
    const L = f.label;
    switch (f.key) {
      case "name":
        return { id: "name", label: L, value: lead.name, editor: "text", editable: canEdit };
      case "phone":
        return { id: "phone", label: L, value: lead.phone, editor: "tel", editable: canEdit && lead.phoneFull, hint: lead.phoneFull ? undefined : "Hidden for your role", mono: true };
      case "altPhone":
        return { id: "altPhone", label: L, value: lead.altPhone ?? "", editor: "tel", editable: canEdit && lead.phoneFull, hint: lead.phoneFull ? undefined : "Hidden for your role", mono: true };
      case "email":
        return { id: "email", label: L, value: lead.email ?? "", editor: "email", editable: canEdit };
      case "city":
        return { id: "custom:city", label: L, value: typeof lead.custom.city === "string" ? lead.custom.city : "", editor: "text", editable: canEdit };
      case "campaign":
        return { id: "campaign", label: L, value: lead.campaign ?? "", editor: "text", editable: canEdit };
      case "stage":
        return { id: "stage", label: L, value: lead.stage, editor: "select", options: lead.stages.map((s) => ({ value: s, label: s })), editable: canEdit && lead.status === "open", hint: lead.status !== "open" ? `Lead is ${lead.status}` : undefined };
      case "owner":
        return { id: "ownerId", label: L, value: lead.ownerId ?? "", display: lead.owner ?? "Unassigned", editor: "select", options: (owners ?? []).map((o) => ({ value: o.id, label: o.name })), editable: canReassign && !!owners?.length };
      case "process":
        return ro("process", L, lead.processName);
      case "source":
        return ro("source", L, SOURCE_LABEL[lead.source] ?? lead.source);
      case "status":
        return ro("status", L, statusText);
      case "lastOutcome":
        return ro("lastOutcome", L, lead.lastDisposition ?? "");
      case "attempts":
        return ro("attempts", L, String(lead.attempts), true);
      case "nextCallback":
        return ro("nextCallback", L, when(lead.nextCallbackAt));
      case "lastActivity":
        return ro("lastActivity", L, when(lead.lastActivityAt));
      case "assignedAt":
        return ro("assignedAt", L, when(lead.assignedAt));
      case "lastEnquiry":
        return ro("lastEnquiry", L, when(lead.lastEnquiryAt));
      case "convertedAt":
        return ro("convertedAt", L, when(lead.convertedAt));
      case "createdAt":
        return ro("createdAt", L, when(lead.createdAt));
      case "dnc":
        return ro("dnc", L, lead.dnc ? "Yes" : "No");
    }
  }

  const sections = lead.layout.map((s) => ({ id: s.id, title: s.title, rows: s.fields.map(rowOf) }));
  // Extra columns that came with the lead (imports, forms) and aren't defined fields.
  const defined = new Set([...lead.fields.map((f) => f.key), "city"]);
  const extras = Object.entries(lead.custom)
    .filter(([k]) => !defined.has(k))
    .map<Row>(([k, v]) => ({ id: `custom:${k}`, label: k.replace(/_/g, " "), value: formatValue(undefined, v), editor: "text", editable: canEdit }));

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

  const cell = (row: Row) => {
    const isEditing = editing === row.id;
    const shown = row.display ?? row.value;
    const wide = row.def?.type === "textarea" || row.def?.type === "multiselect" || row.def?.type === "radio";
    return (
      <div
        key={row.id}
        className={`group relative border-r border-b border-rule px-4 py-3 ${wide ? "col-span-2 xl:col-span-3" : ""} ${row.editable && !isEditing ? "cursor-pointer hover:bg-paper/70" : ""}`}
        onClick={() => row.editable && !isEditing && (setEditing(row.id), setDraft(row.value))}
      >
        <dt className="flex items-center justify-between text-[11px] text-ink-3">
          <span className="truncate capitalize">{row.label}</span>
          {savingId === row.id ? <Loader2 size={12} className="animate-spin text-ink-4" /> : savedId === row.id ? <Check size={12} className="text-moss" /> : row.editable && <Pencil size={11} className="opacity-0 group-hover:opacity-60" />}
        </dt>
        <dd className="mt-0.5 min-h-[22px] text-[14px] font-medium">
          {isEditing ? (
            row.editor === "custom" && row.def ? (
              <div onKeyDown={(e) => e.key === "Escape" && setEditing(null)}>
                <FieldInput def={row.def} value={draft} onChange={setDraft} people={lead.people} autoFocus compact onCommit={(v) => save(row, (v ?? draft).trim())} />
              </div>
            ) : row.editor === "select" ? (
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
                {row.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                ref={(el) => {
                  inputRef.current = el;
                }}
                type={row.editor === "tel" ? "tel" : row.editor === "email" ? "email" : "text"}
                inputMode={row.editor === "tel" ? "tel" : undefined}
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
            row.def?.type === "url" ? (
              <a href={shown} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="break-all text-teal-ink hover:underline">{shown}</a>
            ) : (
              <span className={`${row.mono ? "font-mono tnum" : ""} ${row.def?.type === "textarea" ? "whitespace-pre-wrap" : ""}`}>{shown}</span>
            )
          ) : (
            <span className="text-ink-4">—</span>
          )}
        </dd>
        {row.hint && !isEditing && <p className="mt-0.5 text-[10.5px] text-ink-4">{row.hint}</p>}
      </div>
    );
  };

  return (
    <section className="panel">
      <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
        <span className="eyebrow">Details</span>
        <span className="text-[11.5px] text-ink-4">{canEdit ? "Click a value to edit" : "Read only for your role"}</span>
      </div>
      {sections.map((s) => (
        <div key={s.id}>
          <div className="border-b border-rule bg-paper/60 px-4 py-1.5 text-[11.5px] font-semibold text-ink-2">{s.title}</div>
          <dl className="grid grid-cols-2 xl:grid-cols-3">{s.rows.map(cell)}</dl>
        </div>
      ))}
      {(extras.length > 0 || canEdit) && (
        <div>
          <div className="border-b border-rule bg-paper/60 px-4 py-1.5 text-[11.5px] font-semibold text-ink-2">Other details</div>
          <dl className="grid grid-cols-2 xl:grid-cols-3">
            {extras.map(cell)}
            {canEdit && (
              <div className="border-r border-b border-rule px-4 py-3">
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
        </div>
      )}
    </section>
  );
}
