"use client";

/**
 * Processes: list + create/edit form (stages, won stage, assignment method,
 * working hours, SLA, recycle, dedupe). New processes get default outcomes.
 */
import { useState, useTransition } from "react";
import { Pencil, Plus } from "lucide-react";
import { createProcessAction, updateProcessAction } from "@/app/(app)/admin/actions";
import { ChipPicker, ErrorNote, Field, GhostButton, Input, Select, Submit } from "@/components/ui/form";
import { StageTag } from "@/components/ui/primitives";
import type { AssignmentMethod, Process } from "@/lib/db/schema";

type Row = Process & { agents: number; open: number };

const METHODS: { value: AssignmentMethod; label: string }[] = [
  { value: "equal", label: "Equal (round-robin)" },
  { value: "percentage", label: "Percentage (by share)" },
  { value: "ratio", label: "Ratio (by share)" },
  { value: "number", label: "Number (daily quota)" },
  { value: "load", label: "Load (fewest open leads)" },
  { value: "skill", label: "Skill (tags must match)" },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, value) => ({ value, label }));

function ProcessForm({ initial, onDone }: { initial?: Row; onDone: () => void }) {
  const a = initial?.assignment;
  const [name, setName] = useState(initial?.name ?? "");
  const [stages, setStages] = useState((initial?.stages ?? ["New", "Hot", "Warm", "Cold", "Won"]).join(", "));
  const [wonStage, setWonStage] = useState(initial?.wonStage ?? "Won");
  const [method, setMethod] = useState<AssignmentMethod>(a?.method ?? "equal");
  const [days, setDays] = useState<number[]>(a?.workingHours?.days ?? [1, 2, 3, 4, 5, 6]);
  const [start, setStart] = useState(a?.workingHours?.start ?? "09:30");
  const [end, setEnd] = useState(a?.workingHours?.end ?? "19:30");
  const [sla, setSla] = useState(String(a?.slaMinutes ?? 15));
  const [recycle, setRecycle] = useState(a?.recycleHours ? String(a.recycleHours) : "");
  const [dedupe, setDedupe] = useState(initial?.dedupeField ?? "phoneKey");
  const [reEnquiry, setReEnquiry] = useState(initial?.reEnquiryDays ? String(initial.reEnquiryDays) : "");
  const [status, setStatus] = useState<"active" | "paused" | "closed">(initial?.status ?? "active");
  const [error, setError] = useState<string | null>(null);
  const [busy, start_] = useTransition();
  const stageList = stages.split(",").map((s) => s.trim()).filter(Boolean);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const input = {
      name,
      stages: stageList,
      wonStage,
      method,
      workingDays: days,
      start,
      end,
      slaMinutes: Number(sla),
      recycleHours: recycle ? Number(recycle) : null,
      dedupeField: dedupe,
      reEnquiryDays: reEnquiry ? Number(reEnquiry) : null,
      status,
    };
    start_(async () => {
      const res = initial ? await updateProcessAction(initial.id, input) : await createProcessAction(input);
      if (res.ok) onDone();
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={submit} className="panel grid gap-4 p-5">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Process name" hint="Client · line of business, e.g. “Kosmo Mattress · Sales”">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">Active</option>
            <option value="paused">Paused (no new assignment)</option>
            <option value="closed">Closed</option>
          </Select>
        </Field>
        <Field label="Stages (comma separated, in order)">
          <Input value={stages} onChange={(e) => setStages(e.target.value)} />
        </Field>
        <Field label="Won stage" hint="Reaching it marks the lead converted">
          <Select value={wonStage} onChange={(e) => setWonStage(e.target.value)}>
            {stageList.map((s) => <option key={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="Assignment method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as AssignmentMethod)}>
            {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        </Field>
        <Field label="Dedupe on" hint="phoneKey (last 10 digits), email, or a custom field key">
          <Input value={dedupe} onChange={(e) => setDedupe(e.target.value)} />
        </Field>
      </div>
      <Field label="Working days (tenant timezone)">
        <ChipPicker options={DAYS} value={days} onChange={setDays} />
      </Field>
      <div className="grid grid-cols-5 gap-4">
        <Field label="Start"><Input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="End"><Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        <Field label="SLA (minutes)" hint="Alert if unassigned longer"><Input type="number" min={1} value={sla} onChange={(e) => setSla(e.target.value)} /></Field>
        <Field label="Recycle after (hours)" hint="Blank = never"><Input type="number" min={1} value={recycle} onChange={(e) => setRecycle(e.target.value)} /></Field>
        <Field label="Re-enquiry after (days)" hint="Blank = always merge"><Input type="number" min={1} value={reEnquiry} onChange={(e) => setReEnquiry(e.target.value)} /></Field>
      </div>
      <ErrorNote message={error} />
      <div className="flex items-center gap-2">
        <Submit busy={busy}>{initial ? "Save changes" : "Create process"}</Submit>
        <GhostButton onClick={onDone}>Cancel</GhostButton>
      </div>
    </form>
  );
}

export function ProcessesPanel({ rows, canEdit }: { rows: Row[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<string | "new" | null>(rows.length ? null : "new");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        {canEdit && editing === null && (
          <button onClick={() => setEditing("new")} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-semibold text-sheet hover:bg-ink-2">
            <Plus size={14} /> New process
          </button>
        )}
      </div>
      {editing === "new" && <ProcessForm onDone={() => setEditing(null)} />}
      {rows.length === 0 && editing !== "new" && <p className="panel p-6 text-[13px] text-ink-3">No processes yet.</p>}
      {rows.map((p) =>
        editing === p.id ? (
          <ProcessForm key={p.id} initial={p} onDone={() => setEditing(null)} />
        ) : (
          <article key={p.id} className="panel grid grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_auto]">
            <div className="border-r border-rule p-4">
              <div className="flex items-center gap-2 text-[14.5px] font-semibold">
                {p.name}
                {p.status !== "active" && <span className="text-[11px] font-medium text-ember-ink">{p.status}</span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">{p.stages.map((st) => <StageTag key={st} stage={st} />)}</div>
            </div>
            {[
              { k: "Assignment", v: METHODS.find((m) => m.value === p.assignment.method)?.label.split(" (")[0] ?? p.assignment.method, sub: `${p.agents} agent${p.agents === 1 ? "" : "s"} mapped` },
              { k: "Open leads", v: String(p.open), sub: `dedupe: ${p.dedupeField}`, mono: true },
              {
                k: "Working hours",
                v: p.assignment.workingHours ? `${p.assignment.workingHours.start}–${p.assignment.workingHours.end}` : "Always",
                sub: p.assignment.workingHours ? p.assignment.workingHours.days.map((d) => DAYS[d]!.label).join(" ") : "no limit",
                mono: true,
              },
            ].map((c) => (
              <div key={c.k} className="border-r border-rule p-4">
                <div className="text-[11px] text-ink-3">{c.k}</div>
                <div className={`mt-1 text-[14px] font-semibold ${c.mono ? "font-mono tnum" : ""}`}>{c.v}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-4">{c.sub}</div>
              </div>
            ))}
            <div className="flex items-start p-3">
              {canEdit && (
                <button onClick={() => setEditing(p.id)} aria-label={`Edit ${p.name}`} className="rounded-md p-2 text-ink-3 hover:bg-paper hover:text-ink">
                  <Pencil size={15} />
                </button>
              )}
            </div>
          </article>
        ),
      )}
    </div>
  );
}
