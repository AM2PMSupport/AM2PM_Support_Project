"use client";

/**
 * Setup → Attendance (Jibble), Super Admin only (T2.18–T2.19). One Jibble
 * organisation serves every workspace. Client ID + Secret are saved encrypted
 * and never shown again. Test connection lists which parts of the Jibble API
 * answer; Sync now pulls people, clock events and leave at once. People who
 * didn't match a CRM login by email can be linked to a member here by hand.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { disconnectJibbleAction, linkJibblePersonAction, saveJibbleAction, syncJibbleAction, testJibbleAction } from "@/app/(app)/admin/actions";
import { ErrorNote, Field, GhostButton, Input, Select, Submit } from "@/components/ui/form";

export interface JibbleStatus {
  connected: boolean;
  status: string | null;
  entriesSyncedAt: string | null;
  peopleSyncedAt: string | null;
  leaveSyncedAt: string | null;
  errors: Record<string, string>;
  people: number;
  linked: number;
  unmatched: { id: string; fullName: string; email: string | null; code: string | null }[];
}

const when = (iso: string | null, timeZone: string) =>
  iso ? new Date(iso).toLocaleString("en-IN", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never";

export function JibblePanel({ data, members, timeZone }: { data: JibbleStatus; members: { id: string; label: string }[]; timeZone: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(!data.connected);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tests, setTests] = useState<{ part: string; ok: boolean; detail: string }[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const act = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, done?: (d: unknown) => void) =>
    startTransition(async () => {
      setError(null);
      setNote(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Failed");
      done?.(r.data);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-[760px] text-[12.5px] leading-relaxed text-ink-3">
        People keep clocking in on Jibble; the CRM reads it every 5 minutes and joins it with calls (Attendance screen, Floor, assignment skips people on approved leave). One Jibble organisation for all workspaces; people are matched to CRM logins by email. Create the key in Jibble as an Owner/Admin: Settings → Integrations → API.
      </p>

      <section className="panel p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-[14px] font-semibold">Connection</h3>
          {data.connected && (
            <span className={`inline-flex items-center gap-1.5 text-[12px] ${data.status === "error" ? "text-ember-ink" : "text-moss"}`}>
              {data.status === "error" ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
              {data.status === "error" ? "Connected, last sync had errors" : "Connected"}
            </span>
          )}
        </div>
        {editing ? (
          <form
            className="grid max-w-[620px] grid-cols-1 gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => saveJibbleAction({ clientId, clientSecret }), () => {
                setEditing(false);
                setClientId("");
                setClientSecret("");
                setNote("Saved. Run Test connection, then Sync now.");
              });
            }}
          >
            <Field label="Client ID">
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" required minLength={8} />
            </Field>
            <Field label="Client Secret" hint="Stored encrypted; never shown again">
              <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" required minLength={8} />
            </Field>
            <div className="flex items-center gap-2 sm:col-span-2">
              <Submit busy={busy}>Save</Submit>
              {data.connected && <GhostButton onClick={() => setEditing(false)}>Cancel</GhostButton>}
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <GhostButton disabled={busy} onClick={() => act(() => testJibbleAction(), (d) => setTests(d as typeof tests))}>Test connection</GhostButton>
            <GhostButton disabled={busy} onClick={() => act(() => syncJibbleAction(), (d) => setNote(`Synced: ${Object.entries((d ?? {}) as Record<string, string>).map(([k, v]) => `${k} ${v}`).join(" · ")}`))}>
              <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Sync now
            </GhostButton>
            <GhostButton disabled={busy} onClick={() => setEditing(true)}>Change key</GhostButton>
            <GhostButton danger disabled={busy} onClick={() => act(() => disconnectJibbleAction(), () => setEditing(true))}>Disconnect</GhostButton>
          </div>
        )}
        <ErrorNote message={error} />
        {note && <p className="mt-3 text-[12.5px] text-ink-2">{note}</p>}
        {tests && (
          <ul className="mt-4 flex flex-col gap-1.5 text-[12.5px]">
            {tests.map((t) => (
              <li key={t.part} className="flex items-center gap-2">
                {t.ok ? <CheckCircle2 size={14} className="text-moss" /> : <XCircle size={14} className="text-ember-ink" />}
                <span className="font-medium">{t.part}</span>
                <span className="text-ink-3">{t.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.connected && (
        <section className="panel grid grid-cols-2 sm:grid-cols-4">
          {[
            { k: "Clock events", v: when(data.entriesSyncedAt, timeZone), e: data.errors.entries },
            { k: "People", v: `${data.linked} of ${data.people} linked · ${when(data.peopleSyncedAt, timeZone)}`, e: data.errors.people },
            { k: "Leave", v: when(data.leaveSyncedAt, timeZone), e: data.errors.leave },
            { k: "Holidays", v: when(data.leaveSyncedAt, timeZone), e: data.errors.holidays },
          ].map((x) => (
            <div key={x.k} className="border-r border-b border-rule px-4 py-3 last:border-r-0">
              <div className="eyebrow">{x.k}</div>
              <div className="mt-1 text-[12.5px]">{x.v}</div>
              {x.e && <div className="mt-1 text-[11.5px] text-ember-ink">{x.e}</div>}
            </div>
          ))}
        </section>
      )}

      {data.connected && data.unmatched.length > 0 && (
        <section className="panel overflow-hidden">
          <div className="p-5 pb-3">
            <h3 className="text-[14px] font-semibold">Not matched to a CRM login ({data.unmatched.length})</h3>
            <p className="mt-1 text-[12.5px] text-ink-3">Their Jibble email isn’t a CRM login. Link them to a member of this workspace, or leave them (e.g. staff who don’t use the CRM).</p>
          </div>
          <table className="w-full text-[12.5px]">
            <tbody>
              {data.unmatched.map((p) => (
                <tr key={p.id} className="border-t border-rule">
                  <td className="px-5 py-2 font-medium">{p.fullName}</td>
                  <td className="px-3 py-2 text-ink-3">{p.email ?? "no email"}{p.code ? ` · ${p.code}` : ""}</td>
                  <td className="px-5 py-2">
                    <Select defaultValue="" disabled={busy} onChange={(e) => e.target.value && act(() => linkJibblePersonAction(p.id, e.target.value))} aria-label={`Link ${p.fullName}`}>
                      <option value="">Link to…</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
