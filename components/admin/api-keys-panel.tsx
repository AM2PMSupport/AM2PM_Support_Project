"use client";

/**
 * Setup → API keys: keys for the REST + GraphQL API. A key acts as the admin
 * who created it; "read" = queries only, "write" = also changes. Shown once.
 */
import { useState, useTransition } from "react";
import { createApiKeyAction, revokeApiKeyAction } from "@/app/(app)/admin/actions";
import { ErrorNote, Field, Input, SecretOnce, Select } from "@/components/ui/form";

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  owner: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function ApiKeysPanel({ rows, baseUrl, timeZone }: { rows: ApiKeyRow[]; baseUrl: string; timeZone: string }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }) : "never");

  return (
    <div className="flex max-w-[960px] flex-col gap-4">
      <p className="text-[12.5px] leading-relaxed text-ink-3">
        Use the REST API (<span className="font-mono">{baseUrl}/api/v1/…</span>) or GraphQL (<span className="font-mono">{baseUrl}/api/graphql</span>) with header{" "}
        <span className="font-mono">Authorization: Bearer am2pm_…</span>. A key acts as the admin who created it, inside this workspace only. Full reference: API.md.
      </p>
      <form
        className="panel flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          startTransition(async () => {
            const r = await createApiKeyAction({ name, scope });
            if (!r.ok) return setError(r.error);
            setSecret(r.data!.key);
            setName("");
          });
        }}
      >
        <Field label="Key name" className="w-64"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Client CRM sync" required minLength={2} maxLength={60} /></Field>
        <Field label="Access" className="w-52">
          <Select value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")}>
            <option value="read">Read only</option>
            <option value="write">Read + write</option>
          </Select>
        </Field>
        <button disabled={busy} className="h-9 rounded-md bg-ink px-4 text-[13px] font-semibold text-sheet hover:bg-ink-2 disabled:bg-ink-4">{busy ? "Creating…" : "Create key"}</button>
        <ErrorNote message={error} />
      </form>
      {secret && <SecretOnce label="API key — copy it now, it won't be shown again" value={secret} onDone={() => setSecret(null)} />}
      <div className="panel overflow-hidden">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left text-ink-3">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">Key</th>
              <th className="px-3 py-2.5 font-medium">Access</th>
              <th className="px-3 py-2.5 font-medium">Acts as</th>
              <th className="px-3 py-2.5 font-medium">Last used</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k.id} className={`border-b border-rule last:border-b-0 ${k.revokedAt ? "text-ink-4" : ""}`}>
                <td className="px-4 py-2.5 font-medium">{k.name}</td>
                <td className="px-3 py-2.5 font-mono">{k.prefix}…</td>
                <td className="px-3 py-2.5">{k.scope === "write" ? "Read + write" : "Read only"}</td>
                <td className="px-3 py-2.5">{k.owner}</td>
                <td className="px-3 py-2.5 font-mono">{k.revokedAt ? `revoked ${when(k.revokedAt)}` : when(k.lastUsedAt)}</td>
                <td className="px-3 py-2.5 text-right">
                  {!k.revokedAt && (
                    <button
                      onClick={() => startTransition(async () => { const r = await revokeApiKeyAction(k.id); if (!r.ok) setError(r.error); })}
                      className="h-7 rounded border border-ember/40 px-2.5 text-[12px] font-medium text-ember-ink hover:bg-ember/10"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="px-4 py-6 text-ink-3">No API keys yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
