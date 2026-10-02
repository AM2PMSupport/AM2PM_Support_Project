"use client";

/**
 * Board view (Zoho's Kanban): one column per stage, cards are this page's
 * leads. Dragging a card to another column moves its stage (same rules as
 * the console: closed leads don't move, the won stage converts).
 */
import Link from "next/link";
import { useState } from "react";
import { SOURCE_LABEL, age } from "@/components/leads/meta";
import type { LeadRow } from "@/lib/leads/list";

export function LeadsBoard({
  rows,
  stages,
  canMove,
  onMove,
  renderedAt,
}: {
  rows: LeadRow[];
  stages: string[];
  canMove: boolean;
  onMove: (leadId: string, stage: string) => Promise<string | null>;
  renderedAt: number;
}) {
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Optimistic stage while the server confirms.
  const [moved, setMoved] = useState<Record<string, string>>({});
  const stageOf = (l: LeadRow) => moved[l.id] ?? l.stage;
  const cols = [...stages, ...new Set(rows.map(stageOf).filter((s) => !stages.includes(s)))];

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="rounded bg-ember/10 px-3 py-2 text-[12.5px] text-ember-ink">{error}</p>}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {cols.map((stage) => {
          const cards = rows.filter((l) => stageOf(l) === stage);
          return (
            <section
              key={stage}
              onDragOver={(e) => {
                if (!canMove) return;
                e.preventDefault();
                setOver(stage);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={async (e) => {
                setOver(null);
                const id = e.dataTransfer.getData("text/lead");
                const lead = rows.find((r) => r.id === id);
                if (!lead || stageOf(lead) === stage) return;
                setMoved((m) => ({ ...m, [id]: stage }));
                const err = await onMove(id, stage);
                if (err) {
                  setError(`${lead.name}: ${err}`);
                  setMoved((m) => {
                    const n = { ...m };
                    delete n[id];
                    return n;
                  });
                } else setError(null);
              }}
              className={`flex w-[272px] shrink-0 flex-col rounded-md border bg-paper/60 transition ${over === stage ? "border-teal-ink bg-teal/10" : "border-rule"}`}
            >
              <header className="flex items-center justify-between border-b border-rule px-3 py-2.5">
                <span className="text-[12.5px] font-semibold">{stage}</span>
                <span className="font-mono text-[11.5px] text-ink-3 tnum">{cards.length}</span>
              </header>
              <div className="flex min-h-[120px] flex-col gap-2 p-2">
                {cards.map((l) => (
                  <article
                    key={l.id}
                    draggable={canMove && l.status === "open"}
                    onDragStart={(e) => e.dataTransfer.setData("text/lead", l.id)}
                    className={`rounded border border-rule bg-sheet p-2.5 shadow-[0_1px_0_rgba(21,23,28,0.04)] ${canMove && l.status === "open" ? "cursor-grab active:cursor-grabbing" : ""}`}
                  >
                    <Link href={`/console?lead=${l.id}`} className="block truncate text-[13px] font-semibold hover:underline">{l.name}</Link>
                    <div className="mt-0.5 font-mono text-[11.5px] text-ink-2 tnum">{l.phone}</div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-ink-3">
                      <span className="truncate">{l.owner ?? <span className="text-ember-ink">Unassigned</span>}</span>
                      <span className="shrink-0">{SOURCE_LABEL[l.source] ?? l.source} · {age(l.createdAt, renderedAt)}</span>
                    </div>
                  </article>
                ))}
                {!cards.length && <p className="px-1 py-3 text-center text-[11.5px] text-ink-4">{canMove ? "Drop a lead here" : "No leads"}</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
