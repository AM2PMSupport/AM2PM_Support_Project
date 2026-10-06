"use client";

/**
 * Outcomes (dispositions) per process + custom fields. Category drives what
 * saving an outcome does: callback → schedule, converted → won, dnc → block.
 */
import { useState, useTransition } from "react";
import { createDispositionAction, createFieldAction, toggleDispositionAction, toggleFieldAction } from "@/app/(app)/admin/actions";
import { ErrorNote, Field, Input, Select, Submit, Toggle } from "@/components/ui/form";
import { Tag } from "@/components/ui/primitives";
import type { CustomFieldDefinition, Disposition } from "@/lib/db/schema";

const CAT_TONE = { positive: "teal", converted: "moss", callback: "amber", neutral: "muted", negative: "muted", dnc: "ember" } as const;
const CAT_HELP = {
  positive: "Interested — stays open",
  callback: "Asks for a callback time",
  neutral: "No contact — counts an attempt",
  negative: "Closes the lead as lost",
  converted: "Marks the lead won · fires lead.converted",
  dnc: "Do not call — blocks all outreach",
} as const;

export function OutcomesPanel({
  processes,
  processId,
  outcomes,
  fields,
  canEdit,
}: {
  processes: { id: string; name: string }[];
  processId: string | null;
  outcomes: Disposition[];
  fields: CustomFieldDefinition[];
  canEdit: boolean;
}) {
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<Disposition["category"]>("neutral");
  const [fLabel, setFLabel] = useState("");
  const [fType, setFType] = useState<CustomFieldDefinition["type"]>("text");
  const [fOptions, setFOptions] = useState("");
  const [fRequired, setFRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fError, setFError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-semibold">Call outcomes</h3>
          <form className="flex items-center gap-2" action="/admin" method="get">
            <input type="hidden" name="tab" value="outcomes" />
            <Select name="process" defaultValue={processId ?? ""} onChange={(e) => e.currentTarget.form?.requestSubmit()} className="!h-8 !w-[240px]">
              {processes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </form>
        </div>
        <div className="panel divide-y divide-rule">
          {outcomes.map((d, i) => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-5 font-mono text-[11px] text-ink-4">{i + 1}</span>
              <span className={`flex-1 text-[13px] font-medium ${d.isActive ? "" : "text-ink-4 line-through"}`}>{d.label}</span>
              <Tag tone={CAT_TONE[d.category]}>{d.category}</Tag>
              <span className="hidden w-[210px] text-[11px] text-ink-4 lg:block">{CAT_HELP[d.category]}</span>
              {canEdit && <Toggle checked={d.isActive} onChange={(v) => startTransition(async () => void (await toggleDispositionAction(d.id, v)))} label="" />}
            </div>
          ))}
          {outcomes.length === 0 && <p className="px-4 py-6 text-[13px] text-ink-3">No outcomes — create a process first.</p>}
        </div>
        {canEdit && processId && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const r = await createDispositionAction({ processId, label, category });
                if (r.ok) setLabel("");
                setError(r.ok ? null : r.error);
              });
            }}
            className="panel flex items-end gap-3 p-4"
          >
            <Field label="New outcome" className="flex-1"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Site visit booked" required /></Field>
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value as Disposition["category"])}>
                {Object.keys(CAT_HELP).map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Submit busy={busy}>Add</Submit>
          </form>
        )}
        <ErrorNote message={error} />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-[14px] font-semibold">Custom lead fields</h3>
        <div className="panel divide-y divide-rule">
          {fields.map((f) => (
            <div key={f.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className={`text-[13px] font-medium ${f.isActive ? "" : "text-ink-4 line-through"}`}>
                  {f.label} {f.required && <span className="text-ember">*</span>}
                </div>
                <div className="font-mono text-[11px] text-ink-4">custom.{f.key}{f.options.length ? ` · ${f.options.join(" / ")}` : ""}</div>
              </div>
              <Tag>{f.type}</Tag>
              <Tag tone={f.processId ? "muted" : "teal"}>{f.processId ? "this process" : "all processes"}</Tag>
              {canEdit && <Toggle checked={f.isActive} onChange={(v) => startTransition(async () => void (await toggleFieldAction(f.id, v)))} label="" />}
            </div>
          ))}
          {fields.length === 0 && <p className="px-4 py-6 text-[13px] text-ink-3">No custom fields yet. Imports keep unknown columns anyway.</p>}
        </div>
        {canEdit && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const r = await createFieldAction({
                  entity: "lead",
                  processId,
                  label: fLabel,
                  type: fType,
                  options: fOptions.split(",").map((s) => s.trim()).filter(Boolean),
                  required: fRequired,
                });
                if (r.ok) {
                  setFLabel("");
                  setFOptions("");
                }
                setFError(r.ok ? null : r.error);
              });
            }}
            className="panel grid grid-cols-[1fr_140px] gap-3 p-4"
          >
            <Field label="Field name"><Input value={fLabel} onChange={(e) => setFLabel(e.target.value)} placeholder="e.g. Budget" required /></Field>
            <Field label="Type">
              <Select value={fType} onChange={(e) => setFType(e.target.value as CustomFieldDefinition["type"])}>
                {["text", "textarea", "number", "decimal", "currency", "percent", "dropdown", "radio", "multiselect", "date", "datetime", "boolean", "phone", "email", "url", "user"].map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
            {(fType === "dropdown" || fType === "multiselect" || fType === "radio") && (
              <Field label="Options (comma separated)" className="col-span-2"><Input value={fOptions} onChange={(e) => setFOptions(e.target.value)} /></Field>
            )}
            <div className="col-span-2 flex items-center justify-between">
              <Toggle checked={fRequired} onChange={setFRequired} label="Required" />
              <Submit busy={busy}>Add field</Submit>
            </div>
          </form>
        )}
        <ErrorNote message={fError} />
      </section>
    </div>
  );
}
