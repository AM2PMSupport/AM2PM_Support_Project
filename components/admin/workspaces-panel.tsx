"use client";

/** Workspaces (client organisations) — Super Admin only. */
import { useState, useTransition } from "react";
import { createWorkspaceAction, setWorkspaceStatusAction } from "@/app/(app)/admin/actions";
import { ErrorNote, Field, Input, Select, Submit } from "@/components/ui/form";
import { Tag } from "@/components/ui/primitives";

export interface WorkspaceRow { id: string; name: string; slug: string; status: string; timezone: string; users: number }

export function WorkspacesPanel({ rows, currentId }: { rows: WorkspaceRow[]; currentId: string }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [tz, setTz] = useState("Asia/Kolkata");
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-4">
      <div className="panel divide-y divide-rule">
        {rows.map((w) => (
          <div key={w.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold">{w.name} {w.id === currentId && <span className="text-[11px] font-normal text-ink-4">(you are here)</span>}</div>
              <div className="font-mono text-[11.5px] text-ink-3">{w.slug} · {w.timezone}</div>
            </div>
            <span className="font-mono text-[12px] text-ink-3">{w.users} users</span>
            <Tag tone={w.status === "active" ? "moss" : w.status === "trial" ? "teal" : "ember"}>{w.status}</Tag>
            {w.id !== currentId && (
              <Select
                aria-label={`Status of ${w.name}`}
                value={w.status}
                onChange={(e) => startTransition(async () => void (await setWorkspaceStatusAction(w.id, e.target.value)))}
                className="!h-8 !w-[130px]"
              >
                {["active", "trial", "suspended", "closed"].map((s) => <option key={s}>{s}</option>)}
              </Select>
            )}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const r = await createWorkspaceAction({ name, slug, timezone: tz });
            if (r.ok) { setName(""); setSlug(""); }
            setError(r.ok ? null : r.error);
          });
        }}
        className="panel grid grid-cols-[1.4fr_1fr_1fr_auto] items-end gap-3 p-4"
      >
        <Field label="Client / workspace name"><Input value={name} onChange={(e) => { setName(e.target.value); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} required /></Field>
        <Field label="URL name (slug)" hint="Used in webhook URLs"><Input value={slug} onChange={(e) => setSlug(e.target.value)} required /></Field>
        <Field label="Timezone"><Input value={tz} onChange={(e) => setTz(e.target.value)} /></Field>
        <Submit busy={busy}>Create workspace</Submit>
      </form>
      <ErrorNote message={error} />
    </div>
  );
}
