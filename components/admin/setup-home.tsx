"use client";

/**
 * Setup home (Zoho-style): every setting grouped into cards, with a search
 * box. Only settings the role can open are shown; "Planned" items are
 * greyed out with their phase so nothing looks clickable that isn't built.
 */
import Link from "next/link";
import { useState } from "react";
import { Building2, Database, Plug, Search, ShieldCheck, SlidersHorizontal, Workflow, GraduationCap } from "lucide-react";

export interface SetupItem {
  label: string;
  href?: string; // absent = planned
  hint: string;
  planned?: string; // e.g. "Phase 2"
}
export interface SetupGroup {
  title: string;
  icon: "general" | "security" | "channels" | "custom" | "automation" | "data" | "training";
  items: SetupItem[];
}

const ICONS = {
  general: Building2,
  security: ShieldCheck,
  channels: Plug,
  custom: SlidersHorizontal,
  automation: Workflow,
  data: Database,
  training: GraduationCap,
};

export function SetupHome({ groups, workspace }: { groups: SetupGroup[]; workspace: string }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !needle || `${i.label} ${i.hint} ${g.title}`.toLowerCase().includes(needle)) }))
    .filter((g) => g.items.length);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <label className="flex h-10 w-full max-w-[420px] items-center gap-2 rounded-md border border-rule bg-sheet px-3 focus-within:border-ink">
          <Search size={15} className="text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search setup" className="h-full flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-ink-4" autoFocus aria-label="Search setup" />
        </label>
        <p className="text-[12.5px] text-ink-3">
          Every setting here belongs to <span className="font-semibold text-ink">{workspace}</span>. Switch workspace from your avatar to change another client’s setup.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {shown.map((g) => {
          const Icon = ICONS[g.icon];
          return (
            <section key={g.title} className="panel flex flex-col p-5">
              <h2 className="flex items-center gap-2 text-[14.5px] font-semibold">
                <Icon size={17} strokeWidth={1.8} className="text-ink-2" />
                {g.title}
              </h2>
              <ul className="mt-3 flex flex-col">
                {g.items.map((i) => (
                  <li key={i.label}>
                    {i.href ? (
                      <Link href={i.href} className="group block rounded-md px-2 py-1.5 hover:bg-paper">
                        <span className="text-[13.5px] text-ink group-hover:underline">{i.label}</span>
                        <span className="block text-[11.5px] leading-snug text-ink-4">{i.hint}</span>
                      </Link>
                    ) : (
                      <div className="cursor-default rounded-md px-2 py-1.5 opacity-55" title={`Planned · ${i.planned}`}>
                        <span className="text-[13.5px] text-ink-2">{i.label}</span>
                        <span className="ml-2 rounded-sm bg-ink/[0.06] px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-3">{i.planned}</span>
                        <span className="block text-[11.5px] leading-snug text-ink-4">{i.hint}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {!shown.length && <p className="text-[13px] text-ink-3">Nothing in Setup matches “{q}”.</p>}
      </div>
    </div>
  );
}
