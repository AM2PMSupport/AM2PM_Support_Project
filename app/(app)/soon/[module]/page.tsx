/**
 * One coming-soon module: what it will do, who it's for, where it sits in the
 * plan, and a non-interactive preview on fictional sample data (lib/ui/coming-soon.ts).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { Topbar } from "@/components/shell/topbar";
import { soonModule, SOON_MODULES } from "@/lib/ui/coming-soon";
import { ComingSoonBadge, SoonIcon } from "@/components/soon/soon-icon";

export function generateStaticParams() {
  return SOON_MODULES.map((m) => ({ module: m.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ module: string }> }): Promise<Metadata> {
  const m = soonModule((await params).module);
  return { title: m ? `${m.title} · Coming soon` : "Coming soon" };
}

export default async function SoonModulePage({ params }: { params: Promise<{ module: string }> }) {
  await requirePage("soon");
  const m = soonModule((await params).module);
  if (!m) notFound();
  const { kpis, table, side } = m.preview;

  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar title={m.title} subtitle={`Coming soon · ${m.plan}`} />
      <div className="flex flex-col gap-6 px-6 py-6">
        <div className="flex flex-wrap items-start gap-4">
          <Link href="/soon" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-ink-3 hover:bg-paper hover:text-ink"><ArrowLeft size={14} /> All modules</Link>
          <span className="flex h-11 w-11 items-center justify-center rounded-md bg-teal/15 text-teal-ink"><SoonIcon kind={m.icon} size={22} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-[20px] font-semibold tracking-tight">{m.title}</h2><ComingSoonBadge /></div>
            <p className="mt-1 max-w-[720px] text-[13px] text-ink-3">{m.tagline}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          {/* Preview: looks like the real screen, can't be used. */}
          <section aria-label="Preview with sample data" className="relative">
            <div className="pointer-events-none flex flex-col gap-5 opacity-80 select-none" aria-hidden="true">
              <div className="panel grid grid-cols-2 md:grid-cols-4">
                {kpis.map((k) => (
                  <div key={k.label} className="border-r border-b border-rule px-5 py-4 last:border-r-0 md:border-b-0">
                    <div className="eyebrow">{k.label}</div>
                    <div className="mt-2 font-mono text-[24px] font-semibold leading-none tracking-tight tnum">{k.value}</div>
                    {k.note && <div className="mt-1.5 text-[11.5px] text-ink-4">{k.note}</div>}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                <div className="panel overflow-hidden">
                  <div className="border-b border-rule px-4 py-3 text-[13.5px] font-semibold">{table.title}</div>
                  <table className="w-full text-[12.5px]">
                    <thead><tr className="border-b border-rule text-left text-ink-3">{table.columns.map((c) => <th key={c} className="px-4 py-2 font-medium">{c}</th>)}</tr></thead>
                    <tbody>{table.rows.map((r, i) => <tr key={i} className="border-b border-rule last:border-b-0">{r.map((c, j) => <td key={j} className={`px-4 py-2.5 ${j ? "font-mono text-[12px] tnum" : "font-medium"}`}>{c}</td>)}</tr>)}</tbody>
                  </table>
                </div>
                <div className="panel">
                  <div className="border-b border-rule px-4 py-3 text-[13.5px] font-semibold">{side.title}</div>
                  <ul>{side.items.map((it) => <li key={it.label} className="flex items-center justify-between border-b border-rule px-4 py-2.5 text-[12.5px] last:border-b-0"><span className="text-ink-2">{it.label}</span><span className="font-mono font-semibold tnum">{it.value}</span></li>)}</ul>
                </div>
              </div>
            </div>
            <span className="absolute top-3 right-3 rounded-full border border-amber/40 bg-sheet/95 px-3 py-1 text-[11px] font-semibold text-amber shadow-sm">Preview · sample data</span>
          </section>

          <aside className="flex flex-col gap-4">
            <section className="panel p-5">
              <div className="eyebrow mb-3">What it will do</div>
              <ul className="flex flex-col gap-2.5">{m.features.map((f) => <li key={f} className="flex gap-2 text-[12.5px] leading-relaxed"><Check size={14} className="mt-0.5 shrink-0 text-teal-ink" />{f}</li>)}</ul>
            </section>
            <section className="panel flex flex-col gap-2 p-5 text-[12.5px]">
              <div className="eyebrow mb-1">Plan</div>
              <div className="flex justify-between gap-3"><span className="text-ink-3">For</span><span className="text-right">{m.forWho}</span></div>
              <div className="flex justify-between gap-3"><span className="text-ink-3">Where</span><span className="text-right">{m.plan}</span></div>
              <div className="flex justify-between gap-3"><span className="text-ink-3">Status</span><ComingSoonBadge /></div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
