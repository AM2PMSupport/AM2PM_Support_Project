"use client";

/** Company settings form (name, timezone, currency) + the destructive "Remove sample data" box. */
import { useState, useTransition } from "react";
import { removeSampleDataAction, updateCompanyAction } from "@/app/(app)/admin/actions";
import { ErrorNote, Field, Input, Select } from "@/components/ui/form";

export function CompanyPanel({
  company,
  timezones,
  canEdit,
}: {
  company: { name: string; slug: string; timezone: string; currency: string; status: string; createdAt: string };
  timezones: string[];
  canEdit: boolean;
}) {
  const [name, setName] = useState(company.name);
  const [timezone, setTimezone] = useState(company.timezone);
  const [currency, setCurrency] = useState(company.currency);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, startTransition] = useTransition();
  const zones = timezones.includes(company.timezone) ? timezones : [company.timezone, ...timezones];

  return (
    <form
      className="panel grid max-w-[720px] gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setSaved(false);
        startTransition(async () => {
          const r = await updateCompanyAction({ name, timezone, currency: currency as "INR" });
          if (r.ok) setSaved(true);
          else setError(r.error);
        });
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Workspace name"><Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} required minLength={2} maxLength={80} /></Field>
        <Field label="Workspace ID" hint="Used in webhook URLs; can't change"><Input value={company.slug} disabled /></Field>
        <Field label="Timezone" hint="Working hours, “today”, reminders and reports use this">
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canEdit}>
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </Select>
        </Field>
        <Field label="Currency">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!canEdit}>
            {["INR", "USD", "AED", "GBP", "EUR", "SGD"].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
      </div>
      <p className="text-[12px] text-ink-3">Status: <span className="font-semibold text-ink">{company.status}</span> · created {new Date(company.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</p>
      <ErrorNote message={error} />
      {canEdit && (
        <div className="flex items-center gap-3">
          <button disabled={busy} className="h-9 rounded-md bg-ink px-4 text-[13px] font-semibold text-sheet hover:bg-ink-2 disabled:bg-ink-4">{busy ? "Saving…" : "Save"}</button>
          {saved && <span className="text-[12.5px] text-moss">Saved — applies everywhere in this workspace.</span>}
        </div>
      )}
    </form>
  );
}

export function SampleDataPanel({ summary, canEdit }: { summary: { leads: number } | null; canEdit: boolean }) {
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  if (!summary) return <div className="panel max-w-[720px] p-5 text-[13px] text-ink-3">No sample data in this workspace.</div>;
  return (
    <div className="panel max-w-[720px] border-ember/40 p-5">
      <h3 className="text-[14.5px] font-semibold">Remove sample data</h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
        Deletes the process <span className="font-semibold text-ink">“Demo · Sales (sample leads)”</span> and its {summary.leads} sample leads, calls, callbacks and outcomes. Your real processes and leads are not touched. This can’t be undone.
      </p>
      {canEdit ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Type REMOVE to confirm"><Input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-40" /></Field>
          <button
            disabled={confirm !== "REMOVE" || busy}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const r = await removeSampleDataAction(confirm);
                if (r.ok) setMsg(`Removed ${r.data?.removed ?? 0} sample leads.`);
                else setError(r.error);
              })
            }
            className="h-9 rounded-md bg-ember px-4 text-[13px] font-semibold text-sheet disabled:bg-ink-4"
          >
            {busy ? "Removing…" : "Remove sample data"}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-[12.5px] text-ink-3">Only an admin can remove it.</p>
      )}
      {msg && <p className="mt-3 text-[12.5px] text-moss">{msg}</p>}
      <div className="mt-2"><ErrorNote message={error} /></div>
    </div>
  );
}
