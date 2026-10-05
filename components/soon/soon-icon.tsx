/** Icon per coming-soon module (lib/ui/coming-soon.ts). */
import { Bot, Building2, CalendarClock, GraduationCap, IdCard, Megaphone, PieChart, PlugZap, Receipt, ShieldCheck, Workflow } from "lucide-react";
import type { SoonIcon as Kind } from "@/lib/ui/coming-soon";

const ICONS: Record<Kind, typeof Bot> = {
  reports: PieChart,
  campaigns: Megaphone,
  workflows: Workflow,
  attendance: CalendarClock,
  employees: IdCard,
  billing: Receipt,
  portal: Building2,
  training: GraduationCap,
  backups: ShieldCheck,
  connectors: PlugZap,
  aiqa: Bot,
};

export function SoonIcon({ kind, size = 18 }: { kind: Kind; size?: number }) {
  const Icon = ICONS[kind];
  return <Icon size={size} strokeWidth={1.8} />;
}

export function ComingSoonBadge() {
  return <span className="inline-flex h-[20px] items-center rounded-sm bg-amber-wash px-1.5 text-[10.5px] font-semibold tracking-wide text-amber uppercase">Coming soon</span>;
}
