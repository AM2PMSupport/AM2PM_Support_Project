"use client";

/**
 * "Create Lead" drawer. Goes through the normal lead path (dedupe + assign),
 * so a number that already has an open lead in the process merges instead of
 * creating a duplicate — and the drawer says so.
 */
import Link from "next/link";
import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { createLeadAction } from "@/app/(app)/leads/actions";
import { ErrorNote, Field, Input, Select } from "@/components/ui/form";
import { Portal } from "@/components/ui/portal";

export function CreateLead({
  processes,
  owners,
  canPickOwner,
  onClose,
  onCreated,
}: {
  processes: { id: string; name: string }[];
  owners: { id: string; name: string }[];
  canPickOwner: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [processId, setProcessId] = useState(processes[0]?.id ?? "");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [altPhone, setAltPhone] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [note, setNote] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ leadId: string; merged: boolean } | null>(null);
  const [busy, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await createLeadAction({ processId, name, phone, altPhone, email, city, note, ownerId: ownerId || undefined });
      if (!r.ok) return setError(r.error);
      setDone({ leadId: r.data!.leadId, merged: r.data!.outcome === "merged" });
      onCreated();
    });
  }

  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/25" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Create lead" className="flex h-full w-[420px] flex-col bg-sheet shadow-[-20px_0_60px_-20px_rgba(21,23,28,0.35)]">
        <header className="flex items-center justify-between border-b border-rule px-5 py-4">
          <div>
            <div className="eyebrow">Leads</div>
            <h2 className="text-[16px] font-semibold">Create lead</h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded p-1.5 text-ink-3 hover:bg-paper hover:text-ink"><X size={16} /></button>
        </header>

        {done ? (
          <div className="flex flex-col gap-4 p-5">
            <p className="rounded-md bg-teal/15 px-3 py-3 text-[13px]">
              {done.merged ? "This number already had an open lead in that process — the enquiry was added to it (no duplicate)." : "Lead created and sent for assignment."}
            </p>
            <div className="flex gap-2">
              <Link href={`/console?lead=${done.leadId}`} className="inline-flex h-9 items-center rounded-md bg-ink px-4 text-[13px] font-semibold text-sheet">Open lead</Link>
              <button
                onClick={() => {
                  setDone(null);
                  setName("");
                  setPhone("");
                  setAltPhone("");
                  setEmail("");
                  setCity("");
                  setNote("");
                }}
                className="h-9 rounded-md border border-rule px-4 text-[13px] font-medium text-ink-2 hover:border-ink-3"
              >
                Add another
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
            <Field label="Process">
              <Select value={processId} onChange={(e) => setProcessId(e.target.value)} required>
                {processes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus /></Field>
            <Field label="Mobile" hint="10-digit Indian mobile; +91 optional"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={20} /></Field>
            <Field label="Mobile 2" hint="Optional second number — both can be called"><Input value={altPhone} onChange={(e) => setAltPhone(e.target.value)} inputMode="tel" maxLength={20} /></Field>
            <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} /></Field>
            <Field label="City"><Input value={city} onChange={(e) => setCity(e.target.value)} maxLength={60} /></Field>
            <Field label="Note">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} className="w-full rounded-md border border-rule bg-sheet px-3 py-2 text-[13px] outline-none focus:border-ink" />
            </Field>
            {canPickOwner && (
              <Field label="Lead owner">
                <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  <option value="">Auto-assign (process rules)</option>
                  {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              </Field>
            )}
            <ErrorNote message={error} />
            <div className="mt-auto flex gap-2 border-t border-rule pt-4">
              <button disabled={busy || !processId || !name.trim() || (!phone.trim() && !email.trim())} className="h-9 flex-1 rounded-md bg-ink text-[13px] font-semibold text-sheet hover:bg-ink-2 disabled:bg-ink-4">
                {busy ? "Saving…" : "Create lead"}
              </button>
              <button type="button" onClick={onClose} className="h-9 rounded-md border border-rule px-4 text-[13px] font-medium text-ink-2 hover:border-ink-3">Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
    </Portal>
  );
}
