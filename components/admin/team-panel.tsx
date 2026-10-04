"use client";

/**
 * Team: users with role, phone (for click-to-call), DID, share, caps and
 * process mapping. New user / reset password → password shown once.
 */
import { useState, useTransition } from "react";
import { BadgeCheck, KeyRound, Pencil, PhoneCall, Plus, Search, X } from "lucide-react";
import { createUserAction, resetPasswordAction, testPhoneAction, updateUserAction } from "@/app/(app)/admin/actions";
import { ChipPicker, ErrorNote, Field, GhostButton, Input, SecretOnce, Select, Submit } from "@/components/ui/form";
import { Avatar, Tag } from "@/components/ui/primitives";
import type { Role } from "@/lib/db/schema";
import { ROLE_LABEL } from "@/lib/auth/rbac";

export interface TeamRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: string;
  agentPhoneE164: string | null;
  agentPhoneVerifiedAt: Date | null;
  did: string | null;
  shareWeight: number;
  maxOpenLeads: number;
  openLeads: number;
  dailyQuota: number | null;
  skills: string[];
  processIds: string[];
  lastLoginAt: Date | null;
}


function UserForm({ initial, processes, onDone }: { initial?: TeamRow; processes: { id: string; name: string }[]; onDone: (created?: { password: string | null }) => void }) {
  const [email, setEmail] = useState(initial?.email ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState<Role>(initial?.role ?? "agent");
  const [phone, setPhone] = useState(initial?.agentPhoneE164 ?? "");
  const [did, setDid] = useState(initial?.did ?? "");
  const [share, setShare] = useState(String(initial?.shareWeight ?? 1));
  const [cap, setCap] = useState(String(initial?.maxOpenLeads ?? 50));
  const [quota, setQuota] = useState(initial?.dailyQuota ? String(initial.dailyQuota) : "");
  const [skills, setSkills] = useState((initial?.skills ?? []).join(", "));
  const [procs, setProcs] = useState<string[]>(initial?.processIds ?? []);
  const [status, setStatus] = useState(initial?.status ?? "active");
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const input = {
      email,
      name,
      role,
      phone,
      did,
      shareWeight: Number(share),
      maxOpenLeads: Number(cap),
      dailyQuota: quota ? Number(quota) : null,
      skills: skills.split(",").map((s) => s.trim()).filter(Boolean),
      processIds: procs,
      status,
    };
    startTransition(async () => {
      if (initial) {
        const res = await updateUserAction(initial.id, input);
        if (res.ok) onDone();
        else setError(res.error);
      } else {
        const res = await createUserAction(input);
        if (res.ok) onDone({ password: res.data?.password ?? null }); // null = they already have a login (existing password)
        else setError(res.error);
      }
    });
  }

  return (
    <form onSubmit={submit} className="panel grid gap-4 p-5">
      <div className="grid grid-cols-3 gap-4">
        <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Email (login ID)"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
        </Field>
        <Field label="Phone that rings (click-to-call)" hint="10-digit mobile or desk phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98XXXXXXXX" /></Field>
        <Field label="Own caller-ID DID" hint="Blank = process default"><Input value={did} onChange={(e) => setDid(e.target.value)} /></Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="locked">Locked</option>
          </Select>
        </Field>
        <Field label="Share weight" hint="Percentage / Ratio methods"><Input type="number" min={0} value={share} onChange={(e) => setShare(e.target.value)} /></Field>
        <Field label="Max open leads"><Input type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
        <Field label="Daily quota" hint="Number method; blank = none"><Input type="number" min={0} value={quota} onChange={(e) => setQuota(e.target.value)} /></Field>
      </div>
      <Field label="Skills / tags (comma separated)" hint="Used by the Skill method, e.g. hindi, pune"><Input value={skills} onChange={(e) => setSkills(e.target.value)} /></Field>
      <Field label="Processes this person works on">
        {processes.length ? <ChipPicker options={processes.map((p) => ({ value: p.id, label: p.name }))} value={procs} onChange={setProcs} /> : <span className="text-[12px] text-ink-4">Create a process first.</span>}
      </Field>
      <ErrorNote message={error} />
      <div className="flex gap-2">
        <Submit busy={busy}>{initial ? "Save changes" : "Create user"}</Submit>
        <GhostButton onClick={() => onDone()}>Cancel</GhostButton>
      </div>
    </form>
  );
}

export function TeamPanel({ rows, processes, canEdit }: { rows: TeamRow[]; processes: { id: string; name: string }[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);
  const [linked, setLinked] = useState(false);
  const [rowMsg, setRowMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [, startTransition] = useTransition();
  const procName = new Map(processes.map((p) => [p.id, p.name.split(" · ")[0]]));
  // Find people quickly: name / email / phone digits, role, status, process.
  const [q, setQ] = useState("");
  const [roleF, setRoleF] = useState("");
  const [statusF, setStatusF] = useState("");
  const [procF, setProcF] = useState("");
  const needle = q.trim().toLowerCase();
  const digits = needle.replace(/\D/g, "");
  const shown = rows.filter(
    (u) =>
      (!needle || u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle) || (digits.length >= 3 && (u.agentPhoneE164 ?? "").includes(digits))) &&
      (!roleF || u.role === roleF) &&
      (!statusF || u.status === statusF) &&
      (!procF || u.processIds.includes(procF)),
  );
  const narrowed = !!(q || roleF || statusF || procF);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-9 w-full max-w-[300px] items-center gap-2 rounded-md border border-rule bg-sheet px-2.5 focus-within:border-ink">
          <Search size={14} className="text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or phone digits" className="w-full bg-transparent text-[12.5px] outline-none" aria-label="Search team" />
          {q && <button onClick={() => setQ("")} aria-label="Clear"><X size={13} className="text-ink-3" /></button>}
        </label>
        <select value={roleF} onChange={(e) => setRoleF(e.target.value)} aria-label="Role" className="h-9 rounded-md border border-rule bg-sheet px-2.5 text-[12.5px]">
          <option value="">All roles</option>
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)} aria-label="Status" className="h-9 rounded-md border border-rule bg-sheet px-2.5 text-[12.5px]">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="locked">Locked</option>
        </select>
        {processes.length > 0 && (
          <select value={procF} onChange={(e) => setProcF(e.target.value)} aria-label="Process" className="h-9 rounded-md border border-rule bg-sheet px-2.5 text-[12.5px]">
            <option value="">All processes</option>
            {processes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {narrowed && <span className="text-[12px] text-ink-3">{shown.length} of {rows.length}</span>}
        <span className="flex-1" />
        {canEdit && editing === null && (
          <button onClick={() => setEditing("new")} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-semibold text-sheet hover:bg-ink-2">
            <Plus size={14} /> New user
          </button>
        )}
      </div>
      {linked && (
        <p className="rounded-md bg-teal/15 px-3 py-2.5 text-[12.5px]">
          Added. This person already has an AM2PM login, so they keep their password — this workspace now appears in their workspace switcher.
        </p>
      )}
      {secret && <SecretOnce label={`Password for ${secret.who}`} value={secret.password} onDone={() => setSecret(null)} />}
      {editing === "new" && (
        <UserForm
          processes={processes}
          onDone={(created) => {
            setEditing(null);
            if (created?.password) setSecret({ who: "the new user", password: created.password });
            setLinked(!!created && created.password === null);
          }}
        />
      )}

      <div className="panel overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-rule text-left text-[11.5px] text-ink-3">
              <th className="px-4 py-2.5 font-medium">Person</th>
              <th className="px-3 py-2.5 font-medium">Role</th>
              <th className="px-3 py-2.5 font-medium">Phone</th>
              <th className="px-3 py-2.5 font-medium">Processes</th>
              <th className="px-3 py-2.5 text-right font-medium">Open / cap</th>
              <th className="px-3 py-2.5 text-right font-medium">Share</th>
              <th className="px-4 py-2.5 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {shown.map((u) =>
              editing === u.id ? (
                <tr key={u.id}>
                  <td colSpan={7} className="p-3">
                    <UserForm initial={u} processes={processes} onDone={() => setEditing(null)} />
                  </td>
                </tr>
              ) : (
                <tr key={u.id} className="border-b border-rule last:border-b-0">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar initials={u.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()} size={28} tone={u.role === "agent" ? "teal" : "ink"} />
                      <div className="min-w-0">
                        <div className={`font-semibold ${u.status !== "active" ? "text-ink-4 line-through" : ""}`}>{u.name}</div>
                        <div className="truncate text-[11.5px] text-ink-3">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3"><Tag tone={u.role === "super_admin" || u.role === "admin" ? "ink" : "muted"}>{ROLE_LABEL[u.role]}</Tag></td>
                  <td className="px-3 py-3 font-mono text-[12px] tnum">
                    {u.agentPhoneE164 ? (
                      <span className="inline-flex items-center gap-1">
                        {u.agentPhoneE164}
                        {u.agentPhoneVerifiedAt && <BadgeCheck size={13} className="text-moss" aria-label="Verified" />}
                      </span>
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-[12px] text-ink-2">{u.processIds.map((id) => procName.get(id)).filter(Boolean).join(", ") || <span className="text-ink-4">—</span>}</td>
                  <td className="px-3 py-3 text-right font-mono text-[12px] tnum">{u.openLeads}/{u.maxOpenLeads}</td>
                  <td className="px-3 py-3 text-right font-mono text-[12px] tnum">{u.shareWeight}</td>
                  <td className="px-4 py-3">
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        {u.agentPhoneE164 && (
                          <button
                            title="Ring this phone through CallerDesk"
                            onClick={() =>
                              startTransition(async () => {
                                const r = await testPhoneAction(u.id);
                                setRowMsg({ id: u.id, ok: r.ok, text: r.ok ? "Test call placed — the phone should ring." : r.error });
                              })
                            }
                            className="rounded-md p-1.5 text-ink-3 hover:bg-paper hover:text-ink"
                          >
                            <PhoneCall size={15} />
                          </button>
                        )}
                        <button
                          title="Reset password"
                          onClick={() =>
                            startTransition(async () => {
                              const r = await resetPasswordAction(u.id);
                              if (r.ok && r.data) setSecret({ who: u.name, password: r.data.password });
                              else if (!r.ok) setRowMsg({ id: u.id, ok: false, text: r.error });
                            })
                          }
                          className="rounded-md p-1.5 text-ink-3 hover:bg-paper hover:text-ink"
                        >
                          <KeyRound size={15} />
                        </button>
                        <button title="Edit" onClick={() => setEditing(u.id)} className="rounded-md p-1.5 text-ink-3 hover:bg-paper hover:text-ink">
                          <Pencil size={15} />
                        </button>
                      </div>
                    )}
                    {rowMsg?.id === u.id && <div className={`mt-1 text-right text-[11px] ${rowMsg.ok ? "text-moss" : "text-ember-ink"}`}>{rowMsg.text}</div>}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
