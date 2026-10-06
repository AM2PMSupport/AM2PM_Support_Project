"use client";

/**
 * Setup → Lead layout (Zoho-style, 2026-10-06). Left: field palette (click or
 * drag a type onto a section to create a field), New section, Unused items.
 * Right: sections in two columns; drag fields between positions and
 * sections (or use the ⋯ menu: move up / down / to another section), rename
 * or remove; rename or reorder sections. Everything is a DRAFT until Save
 * (saveLayoutAction → lib/admin/layout.ts, config E, audited). Default puts
 * the standard layout back (still needs Save). Creating or editing a custom
 * field itself is saved at once (it's a field definition, not layout).
 *
 * The saved layout drives Console → Details, the lead page, Create Lead and
 * Leads → Manage Columns (lib/leads/layout.ts).
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  AtSign,
  Calendar,
  CalendarClock,
  CheckSquare,
  ChevronDown,
  CircleDot,
  Hash,
  IndianRupee,
  Link2,
  ListChecks,
  ListFilter,
  Lock,
  MoreHorizontal,
  Percent,
  Phone,
  Plus,
  RotateCcw,
  Type,
  User,
  type LucideIcon,
} from "lucide-react";
import { createLayoutFieldAction, saveLayoutAction, toggleFieldAction, updateFieldAction } from "@/app/(app)/admin/actions";
import { defaultLayout, normalizeLayout, SYSTEM, type Layout, type SystemKey } from "@/lib/leads/layout";
import { ErrorNote, Field, Input, Select } from "@/components/ui/form";
import { Portal } from "@/components/ui/portal";

export interface EditorField {
  id: string;
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  processId: string | null;
}

const TYPES: { type: string; label: string; icon: LucideIcon }[] = [
  { type: "text", label: "Single Line", icon: Type },
  { type: "textarea", label: "Multi-Line", icon: AlignLeft },
  { type: "email", label: "Email", icon: AtSign },
  { type: "phone", label: "Phone", icon: Phone },
  { type: "dropdown", label: "Pick List", icon: ListFilter },
  { type: "multiselect", label: "Multi-Select", icon: ListChecks },
  { type: "date", label: "Date", icon: Calendar },
  { type: "datetime", label: "Date/Time", icon: CalendarClock },
  { type: "number", label: "Number", icon: Hash },
  { type: "decimal", label: "Decimal", icon: Hash },
  { type: "currency", label: "Currency", icon: IndianRupee },
  { type: "percent", label: "Percent", icon: Percent },
  { type: "boolean", label: "Checkbox", icon: CheckSquare },
  { type: "url", label: "URL", icon: Link2 },
  { type: "radio", label: "Radio Button", icon: CircleDot },
  { type: "user", label: "User", icon: User },
];
const TYPE = new Map(TYPES.map((t) => [t.type, t]));
const WITH_OPTIONS = new Set(["dropdown", "multiselect", "radio"]);
const newId = () => `section-${Math.random().toString(36).slice(2, 8)}`;

type Dialog =
  | { kind: "new"; type: string; sectionId: string; before?: string }
  | { kind: "edit"; field: EditorField }
  | { kind: "label"; ref: string }
  | null;

export function LayoutEditor({ initial, fields: initialFields, processes, canEdit }: { initial: Layout; fields: EditorField[]; processes: { id: string; name: string }[]; canEdit: boolean }) {
  const router = useRouter();
  const [fields, setFields] = useState(initialFields);
  const keys = useMemo(() => [...new Set(fields.map((f) => f.key))], [fields]);
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null); // "ref:<ref>" | "type:<type>"
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const fieldOf = (ref: string) => fields.find((f) => `cf:${f.key}` === ref);
  const labelOf = (ref: string) => (ref.startsWith("sys:") ? draft.labels[ref] ?? SYSTEM.get(ref.slice(4) as SystemKey)?.label ?? ref : fieldOf(ref)?.label ?? ref.slice(3));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const isDefault = JSON.stringify(normalizeLayout(draft, keys)) === JSON.stringify(defaultLayout(keys));

  // Move a ref to a section, before `before` (or at the end).
  const place = (ref: string, sectionId: string, before?: string) =>
    setDraft((d) => {
      const sections = d.sections.map((s) => ({ ...s, fields: s.fields.filter((f) => f !== ref) }));
      const target = sections.find((s) => s.id === sectionId);
      if (!target) return d;
      const i = before ? target.fields.indexOf(before) : -1;
      target.fields.splice(i < 0 ? target.fields.length : i, 0, ref);
      return { ...d, sections, hidden: d.hidden.filter((h) => h !== ref) };
    });
  const hide = (ref: string) =>
    setDraft((d) => ({ ...d, sections: d.sections.map((s) => ({ ...s, fields: s.fields.filter((f) => f !== ref) })), hidden: [...d.hidden.filter((h) => h !== ref), ref] }));
  const nudge = (ref: string, by: -1 | 1) =>
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s) => {
        const i = s.fields.indexOf(ref);
        if (i < 0) return s;
        const j = Math.max(0, Math.min(s.fields.length - 1, i + by));
        const f = [...s.fields];
        f.splice(i, 1);
        f.splice(j, 0, ref);
        return { ...s, fields: f };
      }),
    }));
  const moveSection = (id: string, by: -1 | 1) =>
    setDraft((d) => {
      const i = d.sections.findIndex((s) => s.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= d.sections.length) return d;
      const sections = [...d.sections];
      [sections[i], sections[j]] = [sections[j]!, sections[i]!];
      return { ...d, sections };
    });
  const removeSection = (id: string) =>
    setDraft((d) => {
      const s = d.sections.find((x) => x.id === id);
      if (!s || d.sections.length === 1) return d;
      // Its fields go to Unused items (Name / Mobile can't — normalize puts them back in the first section).
      return normalizeLayout({ ...d, sections: d.sections.filter((x) => x.id !== id), hidden: [...d.hidden, ...s.fields] }, keys);
    });

  const onDrop = (sectionId: string, before?: string) => {
    if (!drag) return;
    if (drag.startsWith("ref:")) place(drag.slice(4), sectionId, before);
    else if (drag.startsWith("type:") && canEdit) setDialog({ kind: "new", type: drag.slice(5), sectionId, before });
    setDrag(null);
    setOver(null);
  };

  const save = () =>
    startTransition(async () => {
      setError(null);
      setNote(null);
      const r = await saveLayoutAction(draft);
      if (!r.ok) return setError(r.error);
      const next = normalizeLayout(r.data, keys);
      setSaved(next);
      setDraft(next);
      setNote("Saved — Console, lead page, Create Lead and Manage Columns now use this layout.");
      router.refresh();
    });

  const locked = (ref: string) => ref.startsWith("sys:") && !!SYSTEM.get(ref.slice(4) as SystemKey)?.locked;

  const card = (ref: string, sectionId: string) => {
    const f = fieldOf(ref);
    const sys = ref.startsWith("sys:") ? SYSTEM.get(ref.slice(4) as SystemKey) : undefined;
    const Icon = sys ? (sys.locked ? Lock : Type) : (TYPE.get(f?.type ?? "")?.icon ?? Type);
    const process = f?.processId ? processes.find((p) => p.id === f.processId)?.name : null;
    return (
      <div
        key={ref}
        draggable={canEdit}
        onDragStart={(e) => {
          setDrag(`ref:${ref}`);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => (setDrag(null), setOver(null))}
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          setOver(`${sectionId}:${ref}`);
        }}
        onDrop={(e) => (e.preventDefault(), e.stopPropagation(), onDrop(sectionId, ref))}
        className={`group relative flex items-center gap-2 rounded-md border bg-sheet px-3 py-2.5 text-[13px] ${over === `${sectionId}:${ref}` ? "border-teal-ink shadow-[0_-2px_0_var(--color-teal-ink)]" : "border-rule"} ${f?.required ? "border-l-[3px] border-l-ember" : ""} ${canEdit ? "cursor-grab active:cursor-grabbing" : ""}`}
      >
        <Icon size={14} className="shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{labelOf(ref)}</span>
        {sys && <span className="rounded bg-paper px-1.5 py-0.5 text-[10.5px] text-ink-3">System</span>}
        {process && <span className="max-w-[90px] truncate rounded bg-teal/15 px-1.5 py-0.5 text-[10.5px] text-teal-ink" title={`Only on ${process} leads`}>{process}</span>}
        {canEdit && (
          <button type="button" onClick={() => setMenu(menu === ref ? null : ref)} aria-label={`Options for ${labelOf(ref)}`} className="rounded p-0.5 text-ink-3 hover:bg-paper hover:text-ink">
            <MoreHorizontal size={15} />
          </button>
        )}
        {menu === ref && (
          <FieldMenu
            onClose={() => setMenu(null)}
            items={[
              { label: "Move up", run: () => nudge(ref, -1) },
              { label: "Move down", run: () => nudge(ref, 1) },
              ...draft.sections.filter((s) => s.id !== sectionId).map((s) => ({ label: `Move to “${s.title}”`, run: () => place(ref, s.id) })),
              sys ? { label: "Rename label", run: () => setDialog({ kind: "label", ref }) } : f ? { label: "Edit field", run: () => setDialog({ kind: "edit", field: f }) } : null,
              locked(ref) ? null : { label: "Remove from layout", run: () => hide(ref) },
            ]}
          />
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {canEdit && (
        <div className="sticky top-0 z-[5] flex flex-wrap items-center gap-2 rounded-md border border-rule bg-sheet px-3 py-2">
          <span className="text-[12.5px] text-ink-3">{dirty ? <span className="font-semibold text-ink">Unsaved layout changes</span> : "No unsaved changes"}</span>
          {note && <span className="text-[12px] text-moss">{note}</span>}
          <button type="button" onClick={() => setDraft(defaultLayout(keys))} disabled={busy || isDefault} className="ml-auto inline-flex h-8 items-center gap-1 rounded-md px-3 text-[12.5px] text-ink-2 hover:bg-paper disabled:opacity-40" title="Standard sections and order (then Save)">
            <RotateCcw size={12} /> Default
          </button>
          <button type="button" onClick={() => (setDraft(saved), setError(null))} disabled={busy || !dirty} className="h-8 rounded-md px-3 text-[12.5px] text-ink-2 hover:bg-paper disabled:opacity-40">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy || !dirty} className="h-8 rounded-md bg-ink px-4 text-[12.5px] font-semibold text-sheet hover:bg-ink-2 disabled:opacity-40">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}
      <ErrorNote message={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
        {/* Palette */}
        <aside className="flex flex-col gap-4 rounded-lg bg-ink p-3 text-sheet lg:sticky lg:top-14 lg:self-start">
          <div>
            <div className="mb-2 flex items-center gap-1 text-[12.5px] font-semibold">New fields <ChevronDown size={13} /></div>
            <div className="grid grid-cols-2 gap-1.5">
              {TYPES.map((t) => (
                <button
                  type="button"
                  key={t.type}
                  disabled={!canEdit}
                  draggable={canEdit}
                  onDragStart={(e) => {
                    setDrag(`type:${t.type}`);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onDragEnd={() => (setDrag(null), setOver(null))}
                  onClick={() => setDialog({ kind: "new", type: t.type, sectionId: draft.sections[draft.sections.length - 1]!.id })}
                  title={`Add a ${t.label} field (click, or drag onto a section)`}
                  className="flex items-center gap-1.5 rounded-md bg-white/[0.07] px-2 py-1.5 text-left text-[11.5px] hover:bg-white/[0.14] disabled:opacity-50"
                >
                  <t.icon size={13} className="shrink-0 opacity-80" /> <span className="truncate">{t.label}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => setDraft((d) => ({ ...d, sections: [...d.sections, { id: newId(), title: "New section", fields: [] }] }))}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-white/[0.07] py-2 text-[12px] font-semibold hover:bg-white/[0.14] disabled:opacity-50"
            >
              <Plus size={13} /> NEW SECTION
            </button>
          </div>
          <div>
            <div className="mb-2 text-[12.5px] font-semibold">Unused items ({draft.hidden.length})</div>
            {draft.hidden.length ? (
              <ul className="flex flex-col gap-1">
                {draft.hidden.map((ref) => (
                  <li
                    key={ref}
                    draggable={canEdit}
                    onDragStart={() => setDrag(`ref:${ref}`)}
                    onDragEnd={() => (setDrag(null), setOver(null))}
                    className="flex items-center gap-1.5 rounded-md bg-white/[0.05] px-2 py-1.5 text-[11.5px]"
                  >
                    <span className="min-w-0 flex-1 truncate">{labelOf(ref)}</span>
                    {canEdit && (
                      <button type="button" onClick={() => place(ref, draft.sections[0]!.id)} className="shrink-0 text-teal hover:underline">
                        Add back
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11.5px] text-white/60">Fields you remove from the layout appear here.</p>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-white/60">Red edge = required. “System” fields come with the CRM: move, rename or remove them (Name and Mobile always stay).</p>
        </aside>

        {/* Sections */}
        <div className="flex flex-col gap-4">
          {draft.sections.map((s, i) => (
            <section
              key={s.id}
              className={`panel p-4 ${over === s.id ? "ring-2 ring-teal-ink" : ""}`}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (over !== s.id && !over?.startsWith(`${s.id}:`)) setOver(s.id);
              }}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}
              onDrop={(e) => (e.preventDefault(), onDrop(s.id))}
            >
              <div className="mb-3 flex items-center gap-2">
                <input
                  value={s.title}
                  disabled={!canEdit}
                  onChange={(e) => setDraft((d) => ({ ...d, sections: d.sections.map((x) => (x.id === s.id ? { ...x, title: e.target.value.slice(0, 60) } : x)) }))}
                  aria-label="Section name"
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-[14px] font-semibold outline-none hover:border-rule focus:border-ink disabled:hover:border-transparent"
                />
                <span className="text-[11.5px] text-ink-4">{s.fields.length} fields</span>
                {canEdit && (
                  <>
                    <button type="button" onClick={() => moveSection(s.id, -1)} disabled={i === 0} aria-label="Move section up" className="rounded p-1 text-ink-3 hover:bg-paper hover:text-ink disabled:opacity-30"><ArrowUp size={14} /></button>
                    <button type="button" onClick={() => moveSection(s.id, 1)} disabled={i === draft.sections.length - 1} aria-label="Move section down" className="rounded p-1 text-ink-3 hover:bg-paper hover:text-ink disabled:opacity-30"><ArrowDown size={14} /></button>
                    <button type="button" onClick={() => removeSection(s.id)} disabled={draft.sections.length === 1} className="rounded px-2 py-1 text-[12px] text-ink-3 hover:bg-paper hover:text-ember-ink disabled:opacity-30" title="Remove section (its fields go to Unused items)">
                      Remove
                    </button>
                  </>
                )}
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {s.fields.map((ref) => card(ref, s.id))}
                {!s.fields.length && <p className="rounded-md border border-dashed border-rule px-3 py-6 text-center text-[12.5px] text-ink-4 md:col-span-2">Drag fields here, or add one from the palette.</p>}
              </div>
            </section>
          ))}
        </div>
      </div>

      {dialog?.kind === "new" && (
        <FieldDialog
          title={`New ${TYPE.get(dialog.type)?.label ?? "field"} field`}
          type={dialog.type}
          processes={processes}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const r = await createLayoutFieldAction({ entity: "lead", type: dialog.type, label: v.label, options: v.options, required: v.required, processId: v.processId || null });
            if (!r.ok) return r.error;
            const f = r.data!;
            setFields((fs) => [...fs, { id: f.id, key: f.key, label: f.label, type: f.type, options: f.options, required: f.required, processId: f.processId }]);
            place(`cf:${f.key}`, dialog.sectionId, dialog.before);
            setNote(`“${f.label}” created — Save to keep it where you placed it.`);
            setDialog(null);
            return null;
          }}
        />
      )}
      {dialog?.kind === "edit" && (
        <FieldDialog
          title={`Edit “${dialog.field.label}”`}
          type={dialog.field.type}
          processes={processes}
          initial={dialog.field}
          onClose={() => setDialog(null)}
          onDelete={async () => {
            const r = await toggleFieldAction(dialog.field.id, false);
            if (!r.ok) return r.error;
            setFields((fs) => fs.filter((x) => x.id !== dialog.field.id));
            setDraft((d) => ({ ...d, sections: d.sections.map((s) => ({ ...s, fields: s.fields.filter((x) => x !== `cf:${dialog.field.key}`) })), hidden: d.hidden.filter((x) => x !== `cf:${dialog.field.key}`) }));
            setDialog(null);
            router.refresh();
            return null;
          }}
          onSubmit={async (v) => {
            const r = await updateFieldAction(dialog.field.id, { label: v.label, options: v.options, required: v.required });
            if (!r.ok) return r.error;
            setFields((fs) => fs.map((x) => (x.id === dialog.field.id ? { ...x, label: v.label, options: v.options, required: v.required } : x)));
            setDialog(null);
            router.refresh();
            return null;
          }}
        />
      )}
      {dialog?.kind === "label" && (
        <LabelDialog
          defaultLabel={SYSTEM.get(dialog.ref.slice(4) as SystemKey)?.label ?? ""}
          value={draft.labels[dialog.ref] ?? ""}
          onClose={() => setDialog(null)}
          onSubmit={(label) => {
            setDraft((d) => {
              const labels = { ...d.labels };
              if (label) labels[dialog.ref] = label;
              else delete labels[dialog.ref];
              return { ...d, labels };
            });
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function FieldMenu({ items, onClose }: { items: ({ label: string; run: () => void } | null)[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => (document.removeEventListener("mousedown", down), document.removeEventListener("keydown", key));
  }, [onClose]);
  return (
    <div ref={ref} role="menu" className="absolute top-full right-1 z-20 mt-1 w-[210px] rounded-md border border-rule bg-sheet p-1 shadow-[0_14px_40px_-12px_rgba(21,23,28,0.3)]">
      {items.filter((x): x is { label: string; run: () => void } => !!x).map((it) => (
        <button key={it.label} type="button" role="menuitem" onClick={() => (it.run(), onClose())} className="block w-full truncate rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-paper">
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div role="dialog" aria-label={title} className="w-full max-w-[440px] rounded-lg border border-rule bg-sheet p-5 shadow-[0_18px_50px_-12px_rgba(21,23,28,0.35)]">
          <h3 className="mb-4 text-[15px] font-semibold">{title}</h3>
          {children}
        </div>
      </div>
    </Portal>
  );
}

function FieldDialog({
  title,
  type,
  processes,
  initial,
  onClose,
  onSubmit,
  onDelete,
}: {
  title: string;
  type: string;
  processes: { id: string; name: string }[];
  initial?: EditorField;
  onClose: () => void;
  onSubmit: (v: { label: string; options: string[]; required: boolean; processId: string }) => Promise<string | null>;
  onDelete?: () => Promise<string | null>;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [options, setOptions] = useState((initial?.options ?? []).join("\n"));
  const [required, setRequired] = useState(initial?.required ?? false);
  const [processId, setProcessId] = useState(initial?.processId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const opts = options.split("\n").map((s) => s.trim()).filter(Boolean);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => setError(await onSubmit({ label: label.trim(), options: opts, required, processId })));
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Field label"><Input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={40} autoFocus /></Field>
        {WITH_OPTIONS.has(type) && (
          <Field label="Options" hint="One per line, at least two">
            <textarea value={options} onChange={(e) => setOptions(e.target.value)} rows={5} className="w-full rounded-md border border-rule bg-sheet px-3 py-2 text-[13px] outline-none focus:border-ink" />
          </Field>
        )}
        {!initial && (
          <Field label="Show on" hint="A field for one process only appears on that process's leads">
            <Select value={processId} onChange={(e) => setProcessId(e.target.value)}>
              <option value="">All processes</option>
              {processes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="accent-[var(--color-ink)]" /> Required when creating or editing a lead
        </label>
        <ErrorNote message={error} />
        <div className="mt-1 flex items-center gap-2">
          {onDelete && (
            <button type="button" disabled={busy} onClick={() => startTransition(async () => setError(await onDelete()))} className="h-9 rounded-md px-3 text-[12.5px] text-ember-ink hover:bg-ember/10" title="Turns the field off everywhere; values already saved on leads are kept">
              Delete field
            </button>
          )}
          <button type="button" onClick={onClose} className="ml-auto h-9 rounded-md px-3 text-[13px] text-ink-2 hover:bg-paper">Cancel</button>
          <button disabled={busy || !label.trim() || (WITH_OPTIONS.has(type) && opts.length < 2)} className="h-9 rounded-md bg-ink px-4 text-[13px] font-semibold text-sheet hover:bg-ink-2 disabled:opacity-40">
            {busy ? "Saving…" : initial ? "Save field" : "Create field"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LabelDialog({ defaultLabel, value, onClose, onSubmit }: { defaultLabel: string; value: string; onClose: () => void; onSubmit: (label: string) => void }) {
  const [label, setLabel] = useState(value || defaultLabel);
  return (
    <Modal title={`Rename “${defaultLabel}”`} onClose={onClose}>
      <form onSubmit={(e) => (e.preventDefault(), onSubmit(label.trim() === defaultLabel ? "" : label.trim()))} className="flex flex-col gap-3">
        <Field label="Label shown on every screen" hint={`Built-in name: ${defaultLabel}`}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} autoFocus />
        </Field>
        <div className="flex gap-2">
          <button type="button" onClick={() => onSubmit("")} className="h-9 rounded-md px-3 text-[12.5px] text-ink-3 hover:bg-paper">Use built-in name</button>
          <button type="button" onClick={onClose} className="ml-auto h-9 rounded-md px-3 text-[13px] text-ink-2 hover:bg-paper">Cancel</button>
          <button disabled={!label.trim()} className="h-9 rounded-md bg-ink px-4 text-[13px] font-semibold text-sheet hover:bg-ink-2 disabled:opacity-40">Apply</button>
        </div>
      </form>
    </Modal>
  );
}
