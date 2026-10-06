"use client";

/**
 * Lead sources (webhook URL + one-time key) and telephony (CallerDesk
 * credentials, webhook URL, DIDs → process). Click-to-call only, no SIP.
 */
import { useState, useTransition } from "react";
import { Copy, Plus, RotateCw, Trash2 } from "lucide-react";
import {
  addDidAction,
  createSourceAction,
  removeDidAction,
  rotateSourceKeyAction,
  rotateWebhookAction,
  setCallSyncAction,
  saveCallerDeskAction,
  setSourceStatusAction,
} from "@/app/(app)/admin/actions";
import { ErrorNote, Field, GhostButton, Input, SecretOnce, Select, Submit, Toggle } from "@/components/ui/form";
import { Tag } from "@/components/ui/primitives";

const KIND_LABEL: Record<string, string> = {
  web_form: "Website form",
  meta_ads: "Meta Lead Ads",
  google_ads: "Google Ads",
  indiamart: "IndiaMART",
  justdial: "Justdial",
  csv: "CSV upload",
  sheet: "Google Sheet",
  api: "Public API",
};

export interface SourceRow {
  id: string;
  kind: string;
  processName: string;
  status: string;
  url: string;
  lastLeadAt: Date | null;
  fieldMap: Record<string, string>;
}

export function SourcesPanel({ rows, processes, canEdit }: { rows: SourceRow[]; processes: { id: string; name: string }[]; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("web_form");
  const [processId, setProcessId] = useState(processes[0]?.id ?? "");
  const [mapText, setMapText] = useState("full_name=name\nphone_number=phone\nemail=email");
  const [sheetUrl, setSheetUrl] = useState("");
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  function parseMap(text: string) {
    return Object.fromEntries(
      text
        .split("\n")
        .map((l) => l.split("=").map((s) => s.trim()))
        .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1]),
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="max-w-[620px] text-[12.5px] text-ink-3">
          Each source posts leads to its own URL with a secret key (header <code className="font-mono">x-source-key</code>). Leads are deduped and auto-assigned on arrival.
        </p>
        {canEdit && !open && (
          <button onClick={() => setOpen(true)} disabled={!processes.length} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-semibold text-sheet hover:bg-ink-2 disabled:bg-ink-4">
            <Plus size={14} /> New source
          </button>
        )}
      </div>
      {secret && <SecretOnce label={secret.label} value={secret.value} onDone={() => setSecret(null)} />}
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const r = await createSourceAction({ kind, processId, fieldMap: parseMap(mapText), sheetUrl: kind === "sheet" && sheetUrl ? sheetUrl : undefined });
              if (r.ok && r.data) {
                setOpen(false);
                setSecret({ label: `Source key (URL: ${r.data.url})`, value: r.data.key });
              }
              setError(r.ok ? null : r.error);
            });
          }}
          className="panel grid grid-cols-2 gap-4 p-5"
        >
          <Field label="Source type">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Leads go to process">
            <Select value={processId} onChange={(e) => setProcessId(e.target.value)}>
              {processes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          {kind === "sheet" && (
            <Field label="Published CSV link" hint="Google Sheets → File → Share → Publish to web → CSV" className="col-span-2">
              <Input type="url" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?output=csv" />
            </Field>
          )}
          <Field label="Field map (source field = CRM field)" hint="CRM fields: name, phone, email, or custom.<key>" className="col-span-2">
            <textarea value={mapText} onChange={(e) => setMapText(e.target.value)} rows={4} className="rounded-[5px] border border-rule bg-sheet p-2.5 font-mono text-[12.5px] outline-none focus:border-ink" />
          </Field>
          <div className="col-span-2"><ErrorNote message={error} /></div>
          <div className="col-span-2 flex gap-2">
            <Submit busy={busy}>Create source</Submit>
            <GhostButton onClick={() => setOpen(false)}>Cancel</GhostButton>
          </div>
        </form>
      )}

      <div className="panel divide-y divide-rule">
        {rows.map((s) => (
          <div key={s.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold">
                {KIND_LABEL[s.kind] ?? s.kind}
                <span className="font-normal text-ink-3">→ {s.processName}</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 font-mono text-[11.5px] text-ink-3">
                <span className="truncate">{s.url}</span>
                <button onClick={() => navigator.clipboard.writeText(s.url)} aria-label="Copy URL" className="hover:text-ink"><Copy size={12} /></button>
              </div>
            </div>
            <span className="text-[11.5px] text-ink-4">{s.lastLeadAt ? `last lead ${new Date(s.lastLeadAt).toLocaleString("en-IN")}` : "no leads yet"}</span>
            {canEdit && (
              <>
                <Toggle checked={s.status === "active"} onChange={(v) => startTransition(async () => void (await setSourceStatusAction(s.id, v ? "active" : "paused")))} label={s.status === "active" ? "Live" : "Paused"} />
                <GhostButton
                  onClick={() =>
                    startTransition(async () => {
                      const r = await rotateSourceKeyAction(s.id);
                      if (r.ok && r.data) setSecret({ label: "New source key (old key stops working now)", value: r.data.key });
                    })
                  }
                >
                  <RotateCw size={13} /> New key
                </GhostButton>
              </>
            )}
          </div>
        ))}
        {rows.length === 0 && <p className="px-4 py-6 text-[13px] text-ink-3">No lead sources yet.</p>}
      </div>
    </div>
  );
}

export interface TelephonyData {
  connected: boolean;
  provider: string | null;
  hasWebhookSecret: boolean;
  maskedWebhookUrl: string | null;
  webhookBaseIsLocal: boolean;
  webhookHealth: { lastAt: string | null; last24h: number; failed24h: number; lastError: string | null };
  /** Scheduled 15-min call-report sync on/off. */
  syncCalls: boolean;
  /** Webhooks CallerDesk sent with a wrong key today (old URL still configured there). */
  rejected: { today: number; lastAt: string | null };
  dids: { id: string; number: string; processName: string; direction: string; defaultForOutbound: boolean }[];
}

export function TelephonyPanel({ data, processes, canEdit }: { data: TelephonyData; processes: { id: string; name: string }[]; canEdit: boolean }) {
  const [authCode, setAuthCode] = useState("");
  const [number, setNumber] = useState("");
  const [processId, setProcessId] = useState(processes[0]?.id ?? "");
  const [direction, setDirection] = useState<"inbound" | "outbound" | "both">("both");
  const [isDefault, setIsDefault] = useState(true);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-[680px] text-[12.5px] leading-relaxed text-ink-3">
        Calls run through CallerDesk&apos;s click-to-call API — no SIP, no browser audio. Outbound calls ring the agent&apos;s registered phone first;
        inbound calls are routed by CallerDesk and matched to a process by the number dialled.
      </p>

      <section className="panel p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[14px] font-semibold">CallerDesk</span>
          {data.connected ? <Tag tone="teal">Connected</Tag> : <Tag tone="ember">Not connected</Tag>}
        </div>
        {canEdit && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const r = await saveCallerDeskAction({ authCode });
                if (r.ok) {
                  setAuthCode("");
                  if (r.data?.webhookUrl) setSecret(r.data.webhookUrl);
                }
                setError(r.ok ? null : r.error);
              });
            }}
            className="flex items-end gap-3"
          >
            <Field label={data.connected ? "Replace auth code" : "CallerDesk auth code"} className="flex-1" hint="Stored encrypted; never shown again">
              <Input type="password" autoComplete="off" value={authCode} onChange={(e) => setAuthCode(e.target.value)} required />
            </Field>
            <Submit busy={busy}>{data.connected ? "Update" : "Connect"}</Submit>
          </form>
        )}
        {data.maskedWebhookUrl && (
          <div className="mt-4 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] text-ink-3">Webhook URL for CallerDesk — the secret part is hidden. Don’t copy this line: click <b>New URL</b> and copy the full URL shown once.</div>
              <div className="truncate font-mono text-[12px] text-ink-3 select-none" title="Hidden — click New URL to get a copyable URL">{data.maskedWebhookUrl?.replace("••••••", "[hidden]")}</div>
            </div>
            {canEdit && (
              <GhostButton
                onClick={() =>
                  startTransition(async () => {
                    const r = await rotateWebhookAction();
                    if (r.ok && r.data) setSecret(r.data.webhookUrl);
                  })
                }
              >
                <RotateCw size={13} /> New URL
              </GhostButton>
            )}
          </div>
        )}
        {secret && <div className="mt-3"><SecretOnce label="Webhook URL with secret — paste it into CallerDesk" value={secret} onDone={() => setSecret(null)} /></div>}
        {data.rejected.today > 0 && !secret && (
          <div className="mt-3 rounded-md border border-ember/40 bg-ember/10 px-3 py-2.5 text-[12.5px] text-ember-ink">
            <b>CallerDesk is using an old webhook URL.</b> {data.rejected.today} call event{data.rejected.today === 1 ? " was" : "s were"} refused today
            {data.rejected.lastAt ? ` (last ${new Date(data.rejected.lastAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })})` : ""} because the key in the URL doesn’t match.
            {canEdit ? " Click New URL, then paste the full URL into CallerDesk → Settings → Webhook (both the live-call and call-report webhooks)." : " Ask an admin to update the URL in CallerDesk."}
          </div>
        )}

        {data.connected && (
          <div className="mt-5 grid gap-4 border-t border-rule pt-4 md:grid-cols-2">
            <div>
              <div className="eyebrow">Call events from CallerDesk</div>
              {data.webhookBaseIsLocal ? (
                <p className="mt-2 rounded bg-ember/10 px-3 py-2 text-[12.5px] text-ember-ink">
                  This server’s public address is <b>localhost</b>, which CallerDesk can’t reach. Set PUBLIC_URL to the live site address, then click <b>New URL</b>.
                </p>
              ) : data.webhookHealth.lastAt ? (
                <p className="mt-2 text-[13px]">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-moss" />
                  Last event {new Date(data.webhookHealth.lastAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {data.webhookHealth.last24h} in 24 h
                  {data.webhookHealth.failed24h > 0 && <span className="text-ember-ink"> · {data.webhookHealth.failed24h} failed</span>}
                </p>
              ) : (
                <p className="mt-2 text-[13px] text-ember-ink">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-ember" />
                  No call events received yet — calls will stay “initiated” until CallerDesk sends them.
                </p>
              )}
              {data.webhookHealth.lastError && <p className="mt-1 truncate font-mono text-[11.5px] text-ink-3" title={data.webhookHealth.lastError}>Last error: {data.webhookHealth.lastError}</p>}
              <div className="mt-4">
                <div className="eyebrow mb-1">Call report sync</div>
                {canEdit ? (
                  <Toggle
                    checked={data.syncCalls}
                    onChange={(v) =>
                      startTransition(async () => {
                        const r = await setCallSyncAction(v);
                        setError(r.ok ? null : r.error);
                      })
                    }
                    label={data.syncCalls ? "On — every 15 min" : "Off"}
                  />
                ) : (
                  <span className="text-[13px]">{data.syncCalls ? "On — every 15 min" : "Off"}</span>
                )}
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-4">
                  Pulls CallerDesk’s call report to fill in results and recordings for calls whose webhook never arrived. Turn off if webhooks work reliably; “Sync now” on the Calls screen still works.
                </p>
              </div>
            </div>
            <div className="text-[12.5px] leading-relaxed text-ink-3">
              <div className="eyebrow mb-1">Set up in CallerDesk → Settings → Webhook</div>
              <ol className="list-decimal pl-4">
                <li>Click <b>New URL</b> here and paste the full URL (it starts with https://, never localhost).</li>
                <li>Tick <b>Call Report</b> and <b>Live Call</b>. Leave the member / call-group boxes off.</li>
                <li>Method: <b>POST</b> (recommended) or GET — both work.</li>
                <li>Map each DID below to its process, so incoming calls land in the right place.</li>
                <li>Make one test call; “Last event” above should update within seconds.</li>
              </ol>
            </div>
          </div>
        )}
      </section>

      <section className="panel overflow-hidden">
        <div className="border-b border-rule px-4 py-2.5 text-[13px] font-semibold">Numbers (DIDs)</div>
        <table className="w-full text-[13px]">
          <tbody>
            {data.dids.map((d) => (
              <tr key={d.id} className="border-b border-rule last:border-b-0">
                <td className="px-4 py-2.5 font-mono font-medium tnum">{d.number}</td>
                <td className="px-3 py-2.5 text-ink-2">{d.processName}</td>
                <td className="px-3 py-2.5"><Tag>{d.direction}</Tag> {d.defaultForOutbound && <Tag tone="teal">default caller ID</Tag>}</td>
                <td className="px-4 py-2.5 text-right">
                  {canEdit && (
                    <button onClick={() => startTransition(async () => void (await removeDidAction(d.id)))} aria-label="Remove number" className="rounded p-1.5 text-ink-3 hover:bg-ember-wash hover:text-ember-ink">
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data.dids.length === 0 && (
              <tr><td className="px-4 py-5 text-[13px] text-ink-3">No numbers yet.</td></tr>
            )}
          </tbody>
        </table>
        {canEdit && data.connected && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const r = await addDidAction({ number, processId, direction, defaultForOutbound: isDefault });
                if (r.ok) setNumber("");
                setError(r.ok ? null : r.error);
              });
            }}
            className="grid grid-cols-[1fr_1.4fr_140px_auto_auto] items-end gap-3 border-t border-rule bg-paper/50 p-4"
          >
            <Field label="Number (as registered)"><Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="07971544878" required /></Field>
            <Field label="Routes to">
              <Select value={processId} onChange={(e) => setProcessId(e.target.value)}>
                {processes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Direction">
              <Select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
                <option value="both">Both</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </Select>
            </Field>
            <Toggle checked={isDefault} onChange={setIsDefault} label="Default caller ID" />
            <Submit busy={busy}>Add</Submit>
          </form>
        )}
      </section>
      <ErrorNote message={error} />
    </div>
  );
}
