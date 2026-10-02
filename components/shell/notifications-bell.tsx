"use client";

/**
 * Notifications bell: unread count (orange = something needs attention),
 * dropdown with the latest 20, "mark all read". Polls every 30 s.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bell, CalendarClock, CircleAlert, PhoneMissed, Repeat2 } from "lucide-react";
import { markAllReadAction, notificationsAction } from "@/app/(app)/shell-actions";

type Item = Awaited<ReturnType<typeof notificationsAction>>["items"][number];

const ICON: Record<string, typeof Bell> = {
  callback_due: CalendarClock,
  callback_missed: PhoneMissed,
  missed_call: PhoneMissed,
  lead_merged: Repeat2,
  sla_breach: CircleAlert,
};

function ago(iso: string, now: number) {
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

export function NotificationsBell() {
  const [data, setData] = useState<{ unread: number; items: Item[] }>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const d = await notificationsAction();
      if (alive) {
        setData(d);
        setNow(Date.now());
      }
    };
    const first = setTimeout(load, 0);
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${data.unread ? `, ${data.unread} unread` : ""}`}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-ink-2 ring-1 ring-inset ring-rule transition hover:ring-ink-3"
      >
        <Bell size={16} />
        {data.unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-ember px-1 font-mono text-[10px] font-semibold text-sheet">
            {data.unread > 99 ? "99+" : data.unread}
          </span>
        )}
      </button>
      {open && (
        <div className="panel absolute right-0 top-11 z-30 w-[360px] overflow-hidden shadow-[0_12px_32px_-12px_rgba(21,23,28,0.35)]">
          <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
            <span className="eyebrow">Notifications</span>
            {data.unread > 0 && (
              <button
                onClick={async () => {
                  await markAllReadAction();
                  setData((d) => ({ unread: 0, items: d.items.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })) }));
                }}
                className="text-[11.5px] text-ink-3 hover:text-ink"
              >
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-[420px] overflow-y-auto">
            {data.items.map((n) => {
              const Icon = ICON[n.kind] ?? Bell;
              const urgent = n.kind === "callback_missed" || n.kind === "sla_breach";
              return (
                <li key={n.id} className={`border-b border-rule last:border-b-0 ${n.readAt ? "" : "bg-paper/70"}`}>
                  <Link href={n.link ?? "#"} onClick={() => setOpen(false)} className="flex gap-3 px-4 py-3 hover:bg-paper">
                    <Icon size={15} className={`mt-0.5 shrink-0 ${urgent ? "text-ember" : "text-ink-3"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold leading-snug">{n.title}</span>
                      {n.body && <span className="mt-0.5 block text-[12px] text-ink-3">{n.body}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-4">{ago(n.createdAt, now)}</span>
                  </Link>
                </li>
              );
            })}
            {data.items.length === 0 && <li className="px-4 py-8 text-center text-[12.5px] text-ink-3">You&apos;re all caught up.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
