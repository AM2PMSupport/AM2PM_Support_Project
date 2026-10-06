/**
 * Lead layout — pure, no I/O (Setup → Lead layout, 2026-10-06; DESIGN.md §9).
 *
 * One layout per workspace: ordered SECTIONS of fields, a HIDDEN list
 * ("Unused items") and display-label overrides for system fields. A field is
 * a ref: `sys:<key>` for a built-in field (SYSTEM_FIELDS) or `cf:<key>` for a
 * custom field (custom_field_definitions.key). Every lead screen renders from
 * it: Console → Details, the lead page, Create Lead and Leads → Manage
 * Columns — so a field added or moved here shows up everywhere.
 *
 * normalizeLayout makes any stored / submitted layout safe: unknown refs are
 * dropped, every known field appears exactly once (placed or hidden), new
 * custom fields land at the end of the last section, Name and Mobile can
 * never be hidden (dedupe and calling need them), and an empty layout falls
 * back to the default.
 */
import type { ColumnKey } from "@/components/leads/meta";

export type SystemKey =
  | "name"
  | "phone"
  | "altPhone"
  | "email"
  | "city"
  | "campaign"
  | "stage"
  | "owner"
  | "process"
  | "source"
  | "status"
  | "lastOutcome"
  | "attempts"
  | "nextCallback"
  | "lastActivity"
  | "assignedAt"
  | "lastEnquiry"
  | "convertedAt"
  | "createdAt"
  | "dnc";

export interface SystemField {
  key: SystemKey;
  label: string;
  /** Editable on the lead page / console (subject to role). */
  editable: boolean;
  /** Shown on Create Lead. */
  creatable: boolean;
  /** Can't be hidden. */
  locked: boolean;
  /** Matching Leads grid column, if any. */
  column?: ColumnKey;
}

export const SYSTEM_FIELDS: SystemField[] = [
  { key: "name", label: "Name", editable: true, creatable: true, locked: true },
  { key: "phone", label: "Mobile", editable: true, creatable: true, locked: true, column: "phone" },
  { key: "altPhone", label: "Mobile 2", editable: true, creatable: true, locked: false },
  { key: "email", label: "Email", editable: true, creatable: true, locked: false, column: "email" },
  { key: "city", label: "City", editable: true, creatable: true, locked: false, column: "city" },
  { key: "campaign", label: "Campaign", editable: true, creatable: true, locked: false, column: "campaign" },
  { key: "stage", label: "Stage", editable: true, creatable: false, locked: false, column: "stage" },
  { key: "owner", label: "Lead owner", editable: true, creatable: true, locked: false, column: "owner" },
  { key: "process", label: "Process", editable: false, creatable: false, locked: false, column: "process" },
  { key: "source", label: "Source", editable: false, creatable: false, locked: false, column: "source" },
  { key: "status", label: "Status", editable: false, creatable: false, locked: false },
  { key: "lastOutcome", label: "Last outcome", editable: false, creatable: false, locked: false, column: "outcome" },
  { key: "attempts", label: "Attempts", editable: false, creatable: false, locked: false, column: "attempts" },
  { key: "nextCallback", label: "Next callback", editable: false, creatable: false, locked: false, column: "callback" },
  { key: "lastActivity", label: "Last activity", editable: false, creatable: false, locked: false, column: "activity" },
  { key: "assignedAt", label: "Assigned", editable: false, creatable: false, locked: false },
  { key: "lastEnquiry", label: "Last enquiry", editable: false, creatable: false, locked: false },
  { key: "convertedAt", label: "Converted", editable: false, creatable: false, locked: false },
  { key: "createdAt", label: "Created", editable: false, creatable: false, locked: false, column: "created" },
  { key: "dnc", label: "Do not call", editable: false, creatable: false, locked: false },
];
export const SYSTEM = new Map(SYSTEM_FIELDS.map((f) => [f.key, f]));

export interface LayoutSection {
  id: string;
  title: string;
  fields: string[];
}

export interface Layout {
  sections: LayoutSection[];
  /** Refs the admin removed from the screens ("Unused items"). */
  hidden: string[];
  /** Display labels for system fields (custom fields are renamed on their definition). */
  labels: Record<string, string>;
}

/** The custom field definition bits a layout needs. */
export interface FieldDef {
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
}

export const MAX_SECTIONS = 30;
const sys = (k: SystemKey) => `sys:${k}`;

export function defaultLayout(customKeys: string[]): Layout {
  return {
    sections: [
      { id: "lead-information", title: "Lead information", fields: ["name", "phone", "altPhone", "email", "city", "campaign", "stage", "owner"].map((k) => sys(k as SystemKey)) },
      { id: "additional-details", title: "Additional details", fields: customKeys.map((k) => `cf:${k}`) },
      {
        id: "system",
        title: "System information",
        fields: (["process", "source", "status", "lastOutcome", "attempts", "nextCallback", "lastActivity", "assignedAt", "lastEnquiry", "convertedAt", "createdAt", "dnc"] as SystemKey[]).map(sys),
      },
    ],
    hidden: [],
    labels: {},
  };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Any input (stored JSON, a form) → a valid layout for these custom fields. */
export function normalizeLayout(raw: unknown, customKeys: string[]): Layout {
  const known = new Set([...SYSTEM_FIELDS.map((f) => sys(f.key)), ...customKeys.map((k) => `cf:${k}`)]);
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Layout, unknown>>;
  const rawSections = Array.isArray(r.sections) ? r.sections.slice(0, MAX_SECTIONS) : [];
  if (!rawSections.length) return defaultLayout(customKeys);

  const seen = new Set<string>();
  const ids = new Set<string>();
  const sections: LayoutSection[] = rawSections.map((s, i) => {
    const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    let id = str(o.id, 40).replace(/[^a-z0-9-]/gi, "") || `section-${i + 1}`;
    while (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    const fields: string[] = [];
    for (const f of Array.isArray(o.fields) ? o.fields : []) {
      if (typeof f !== "string" || !known.has(f) || seen.has(f)) continue; // also catches a repeat in the same section
      seen.add(f);
      fields.push(f);
    }
    return { id, title: str(o.title, 60) || "Section", fields };
  });

  const hiddenIn = Array.isArray(r.hidden) ? r.hidden : [];
  const hidden: string[] = [];
  for (const f of hiddenIn) {
    if (typeof f !== "string" || !known.has(f) || seen.has(f)) continue;
    if (SYSTEM.get(f.slice(4) as SystemKey)?.locked) {
      sections[0]!.fields.push(f); // Name / Mobile can't be hidden
    } else hidden.push(f);
    seen.add(f);
  }

  // Fields the layout doesn't mention yet (new custom fields, new system fields).
  for (const f of known) {
    if (seen.has(f)) continue;
    (f.startsWith("cf:") ? sections[sections.length - 1]! : sections[0]!).fields.push(f);
  }

  const labelsIn = (r.labels && typeof r.labels === "object" ? r.labels : {}) as Record<string, unknown>;
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(labelsIn)) {
    const label = str(v, 40);
    if (k.startsWith("sys:") && SYSTEM.has(k.slice(4) as SystemKey) && label && label !== SYSTEM.get(k.slice(4) as SystemKey)!.label) labels[k] = label;
  }
  return { sections, hidden, labels };
}

export type ResolvedField =
  | { ref: string; kind: "sys"; key: SystemKey; label: string; system: SystemField }
  | { ref: string; kind: "cf"; key: string; label: string; def: FieldDef };

export interface ResolvedSection {
  id: string;
  title: string;
  fields: ResolvedField[];
}

/**
 * The layout for ONE lead: `defs` are the custom fields of the lead's process
 * (workspace-wide + that process). Custom fields of other processes are left
 * out; hidden fields are left out; empty sections are dropped.
 */
export function resolveLayout(layout: Layout, defs: FieldDef[]): ResolvedSection[] {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const hidden = new Set(layout.hidden);
  return layout.sections
    .map((s) => ({
      id: s.id,
      title: s.title,
      fields: s.fields.flatMap<ResolvedField>((ref) => {
        if (hidden.has(ref)) return [];
        if (ref.startsWith("sys:")) {
          const f = SYSTEM.get(ref.slice(4) as SystemKey);
          return f ? [{ ref, kind: "sys", key: f.key, label: layout.labels[ref] ?? f.label, system: f }] : [];
        }
        const d = byKey.get(ref.slice(3));
        return d ? [{ ref, kind: "cf", key: d.key, label: d.label, def: d }] : [];
      }),
    }))
    .filter((s) => s.fields.length);
}

/** Leads → Manage Columns: every visible field that can be a column, in layout order. */
export function layoutColumns(layout: Layout, defs: FieldDef[]): { key: string; label: string }[] {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const hidden = new Set(layout.hidden);
  return layout.sections.flatMap((s) =>
    s.fields.flatMap((ref) => {
      if (hidden.has(ref)) return [];
      if (ref.startsWith("sys:")) {
        const f = SYSTEM.get(ref.slice(4) as SystemKey);
        return f?.column ? [{ key: f.column as string, label: layout.labels[ref] ?? f.label }] : [];
      }
      const d = byKey.get(ref.slice(3));
      return d ? [{ key: `cf:${d.key}`, label: d.label }] : [];
    }),
  );
}
