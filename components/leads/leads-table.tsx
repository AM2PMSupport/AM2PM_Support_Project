"use client";

/**
 * Leads list with quick search. The search box uses the SAME classifier as
 * the server search (lib/leads/search.ts): email text, full phone, last
 * digits, or name — so what an agent types behaves identically once this
 * screen calls GET /api/v1/search (T1.47).
 */
import { useMemo, useState } from "react";
import { PhoneMissed, Search, X } from "lucide-react";
import { Kbd, StageTag, Tag } from "@/components/ui/primitives";
import { classifyQuery } from "@/lib/leads/search-classify";
import { QUEUE, SOURCE_LABEL, ago, formatPhone, type QueueLead, type Stage } from "@/lib/ui/sample-data";

const STAGES: (Stage | "All")[] = ["All", "New", "Hot", "Warm", "Cold"];

function matches(l: QueueLead, q: string): boolean {
  const c = classifyQuery(q);
  if (!c) return true;
  const digits = l.phone.replace(/\D/g, "").slice(-10);
  switch (c.kind) {
    case "email":
      return (l.email ?? "").toLowerCase().includes(c.value);
    case "phone_exact":
      return digits === c.value;
    case "phone_partial":
      return digits.includes(c.value);
    case "name":
      return l.name.toLowerCase().includes(c.value.toLowerCase());
  }
}

const KIND_LABEL = { email: "email", phone_exact: "exact phone", phone_partial: "phone digits", name: "name" } as const;

export function LeadsTable() {
  const [q, setQ] = useState("");
  const [stage, setStage] = useState<(typeof STAGES)[number]>("All");
  const kind = classifyQuery(q);
  const rows = useMemo(() => QUEUE.filter((l) => matches(l, q) && (stage === "All" || l.stage === stage)), [q, stage]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex h-10 w-full max-w-[460px] items-center gap-2 rounded-md border border-rule bg-sheet px-3 focus-within:border-ink">
          <Search size={16} className="text-ink-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Try “Ana”, “2233”, or “@example.in”"
            className="h-full flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-4"
            aria-label="Search leads"
          />
          {q ? (
            <button onClick={() => setQ("")} aria-label="Clear search" className="text-ink-3 hover:text-ink">
              <X size={15} />
            </button>
          ) : (
            <Kbd>/</Kbd>
          )}
        </label>
        {kind && <span className="text-[12px] text-ink-3">Searching by <span className="font-semibold text-ink">{KIND_LABEL[kind.kind]}</span></span>}

        <div className="ml-auto flex items-center rounded-md border border-rule bg-sheet p-0.5">
          {STAGES.map((s) => (
            <button
              key={s}
              onClick={() => setStage(s)}
              className={`h-8 rounded-[4px] px-3 text-[12.5px] font-medium transition ${stage === s ? "bg-ink text-sheet" : "text-ink-3 hover:text-ink"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="panel overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-rule text-left text-[11.5px] text-ink-3">
              <th className="px-4 py-2.5 font-medium">Lead</th>
              <th className="px-3 py-2.5 font-medium">Phone</th>
              <th className="px-3 py-2.5 font-medium">Process</th>
              <th className="px-3 py-2.5 font-medium">Source</th>
              <th className="px-3 py-2.5 font-medium">Stage</th>
              <th className="px-3 py-2.5 font-medium">Last outcome</th>
              <th className="px-3 py-2.5 text-right font-medium">Next callback</th>
              <th className="px-4 py-2.5 text-right font-medium">Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const overdue = l.callbackInMin !== undefined && l.callbackInMin <= 0;
              return (
                <tr key={l.id} className="border-b border-rule last:border-b-0 hover:bg-paper/70">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 font-semibold">
                      {l.name}
                      {l.missedCall && <PhoneMissed size={13} className="text-ember" aria-label="Missed call" />}
                    </div>
                    <div className="font-mono text-[11px] text-ink-4">{l.id} · {l.city}</div>
                  </td>
                  <td className="px-3 py-3 font-mono text-[12.5px] tnum">{formatPhone(l.phone)}</td>
                  <td className="px-3 py-3 text-ink-2">{l.process.split(" · ")[0]}</td>
                  <td className="px-3 py-3"><Tag>{SOURCE_LABEL[l.source]}</Tag></td>
                  <td className="px-3 py-3"><StageTag stage={l.stage} /></td>
                  <td className="px-3 py-3 text-ink-2">{l.lastDisposition ?? <span className="text-ink-4">—</span>}</td>
                  <td className={`px-3 py-3 text-right font-mono text-[12px] tnum ${overdue ? "font-semibold text-ember-ink" : "text-ink-2"}`}>
                    {l.callbackInMin === undefined ? <span className="text-ink-4">—</span> : overdue ? `overdue ${ago(-l.callbackInMin)}` : `in ${ago(l.callbackInMin)}`}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-ink-3 tnum">{ago(l.ageMin)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-14 text-center text-[13px] text-ink-3">
                  No leads match “{q}”. Search needs 2+ letters or 3+ digits.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
