/**
 * SAMPLE DATA for the UI preview — fictional clients, agents and customers.
 *
 * Used until sign-in (TASK.md T1.11) lets the screens call the real APIs.
 * Shapes mirror the database (lib/db/schema.ts) so swapping each export for
 * a server query is mechanical. Nothing here is real customer data.
 * Times are "minutes ago / from now" offsets so server and client render the
 * same text (no hydration mismatch).
 */

export type Stage = "New" | "Hot" | "Warm" | "Cold" | "Won";
export type SourceKind = "meta_ads" | "web_form" | "indiamart" | "justdial" | "inbound_call" | "csv" | "google_ads";
export type AgentStatus = "available" | "on_call" | "wrap_up" | "break" | "offline";

export const SOURCE_LABEL: Record<SourceKind, string> = {
  meta_ads: "Meta Ads",
  web_form: "Website",
  indiamart: "IndiaMART",
  justdial: "Justdial",
  inbound_call: "Inbound call",
  csv: "CSV import",
  google_ads: "Google Ads",
};

export interface QueueLead {
  id: string;
  name: string;
  phone: string; // E.164
  city: string;
  process: string;
  source: SourceKind;
  campaign?: string;
  stage: Stage;
  attempts: number;
  /** Minutes since the lead arrived. */
  ageMin: number;
  /** Negative = overdue by N minutes; positive = due in N minutes. */
  callbackInMin?: number;
  missedCall?: boolean;
  custom: Record<string, string>;
  lastDisposition?: string;
  email?: string;
  dnc?: boolean;
}

export interface TimelineItem {
  id: string;
  kind: "created" | "assigned" | "call" | "whatsapp" | "disposition" | "merged" | "callback" | "note";
  title: string;
  detail?: string;
  /** Minutes ago. */
  agoMin: number;
  by?: string;
  tone?: "teal" | "ember" | "moss" | "ink";
}

export interface Disposition {
  code: string;
  label: string;
  category: "positive" | "negative" | "neutral" | "callback" | "dnc" | "converted";
  key: string; // keyboard shortcut
}

export interface Agent {
  id: string;
  name: string;
  initials: string;
  status: AgentStatus;
  /** Minutes in current status. */
  forMin: number;
  calls: number;
  talkMin: number;
  conversions: number;
  openLeads: number;
  maxOpen: number;
  process: string;
}

export const ME = { id: "u-1", name: "Rohit Kumar", initials: "RK", role: "Agent", did: "079 7154 4878" };

export const DISPOSITIONS: Disposition[] = [
  { code: "INTERESTED", label: "Interested", category: "positive", key: "1" },
  { code: "CALL_BACK", label: "Call back", category: "callback", key: "2" },
  { code: "NO_ANSWER", label: "No answer", category: "neutral", key: "3" },
  { code: "BUSY", label: "Busy", category: "neutral", key: "4" },
  { code: "NOT_INTERESTED", label: "Not interested", category: "negative", key: "5" },
  { code: "WRONG_NUMBER", label: "Wrong number", category: "negative", key: "6" },
  { code: "SALE", label: "Order placed", category: "converted", key: "7" },
  { code: "DNC", label: "Do not call", category: "dnc", key: "8" },
];

export const QUEUE: QueueLead[] = [
  {
    id: "L-2041", name: "Ananya Iyer", phone: "+919845012233", city: "Bengaluru", process: "Kosmo Mattress · Sales",
    source: "meta_ads", campaign: "Diwali Sleep Sale", stage: "Hot", attempts: 2, ageMin: 1440, callbackInMin: -12,
    custom: { Size: "King", Budget: "₹38,000", "Old mattress": "Yes" }, lastDisposition: "Call back", email: "ananya.iyer@example.in",
  },
  {
    id: "L-2058", name: "Mohit Bansal", phone: "+919811840027", city: "Delhi", process: "Kosmo Mattress · Sales",
    source: "inbound_call", stage: "New", attempts: 0, ageMin: 6, missedCall: true,
    custom: { Size: "—", Budget: "—" },
  },
  {
    id: "L-2060", name: "Fatima Shaikh", phone: "+919930711452", city: "Mumbai", process: "Kosmo Mattress · Sales",
    source: "web_form", stage: "New", attempts: 0, ageMin: 3,
    custom: { Size: "Queen", Budget: "₹22,000" }, email: "fatima.s@example.in",
  },
  {
    id: "L-2033", name: "Gurpreet Sandhu", phone: "+919876502118", city: "Ludhiana", process: "Kosmo Mattress · Sales",
    source: "google_ads", campaign: "Ortho Range", stage: "Warm", attempts: 1, ageMin: 2880, callbackInMin: 25,
    custom: { Size: "Queen", Budget: "₹30,000", "Back pain": "Yes" }, lastDisposition: "Interested",
  },
  {
    id: "L-2052", name: "Sneha Kulkarni", phone: "+919822360941", city: "Pune", process: "Veda Realty · Site visits",
    source: "indiamart", stage: "New", attempts: 0, ageMin: 18,
    custom: { Config: "2 BHK", Budget: "₹85 L", Timeline: "3 months" },
  },
  {
    id: "L-2019", name: "Arjun Reddy", phone: "+919849077310", city: "Hyderabad", process: "Kosmo Mattress · Sales",
    source: "justdial", stage: "Warm", attempts: 3, ageMin: 4320, callbackInMin: 95,
    custom: { Size: "Single", Budget: "₹12,000" }, lastDisposition: "Busy",
  },
  {
    id: "L-2061", name: "Kavya Menon", phone: "+919446219987", city: "Kochi", process: "Sprout Learning · Admissions",
    source: "meta_ads", campaign: "Grade 6 Coding", stage: "New", attempts: 0, ageMin: 1,
    custom: { Grade: "6", Course: "Coding Jr." },
  },
  {
    id: "L-2007", name: "Imran Qureshi", phone: "+919819055402", city: "Mumbai", process: "Veda Realty · Site visits",
    source: "csv", stage: "Cold", attempts: 4, ageMin: 10080, callbackInMin: 240,
    custom: { Config: "3 BHK", Budget: "₹1.4 Cr" }, lastDisposition: "No answer",
  },
  {
    id: "L-2049", name: "Divya Agarwal", phone: "+919829441630", city: "Jaipur", process: "Kosmo Mattress · Sales",
    source: "web_form", stage: "Hot", attempts: 1, ageMin: 95,
    custom: { Size: "King", Budget: "₹45,000" }, lastDisposition: "Interested",
  },
];

export const TIMELINE: Record<string, TimelineItem[]> = {
  "L-2041": [
    { id: "t1", kind: "callback", title: "Callback due", detail: "Asked to call after 6 pm", agoMin: 12, tone: "ember" },
    { id: "t2", kind: "disposition", title: "Call back", detail: "Wants to compare King vs Queen pricing", agoMin: 1380, by: "Rohit Kumar", tone: "ink" },
    { id: "t3", kind: "call", title: "Outbound call · 3m 41s", detail: "Connected via click-to-call · DID 079 7154 4878", agoMin: 1384, by: "Rohit Kumar", tone: "teal" },
    { id: "t4", kind: "whatsapp", title: "WhatsApp template sent", detail: "diwali_offer_v2 · delivered, read", agoMin: 1400, tone: "moss" },
    { id: "t5", kind: "merged", title: "Re-enquired from Meta Ads", detail: "Same phone, merged into this lead", agoMin: 1420, tone: "ink" },
    { id: "t6", kind: "assigned", title: "Assigned to Rohit Kumar", detail: "Percentage method · 40% share", agoMin: 1439, tone: "ink" },
    { id: "t7", kind: "created", title: "Lead created", detail: "Meta Lead Ads · form “Diwali Sleep Sale”", agoMin: 1440, tone: "ink" },
  ],
};

export function timelineFor(lead: QueueLead): TimelineItem[] {
  return (
    TIMELINE[lead.id] ?? [
      ...(lead.missedCall ? [{ id: "m", kind: "call" as const, title: "Missed inbound call", detail: "Rang 28s · nobody free · callback created", agoMin: lead.ageMin, tone: "ember" as const }] : []),
      { id: "a", kind: "assigned", title: "Assigned to Rohit Kumar", detail: "Auto-assignment", agoMin: Math.max(lead.ageMin - 1, 0), tone: "ink" },
      { id: "c", kind: "created", title: "Lead created", detail: SOURCE_LABEL[lead.source], agoMin: lead.ageMin, tone: "ink" },
    ]
  );
}

export const AGENTS: Agent[] = [
  { id: "u-1", name: "Rohit Kumar", initials: "RK", status: "on_call", forMin: 3, calls: 41, talkMin: 126, conversions: 4, openLeads: 38, maxOpen: 50, process: "Kosmo" },
  { id: "u-2", name: "Priya Nair", initials: "PN", status: "available", forMin: 1, calls: 47, talkMin: 141, conversions: 6, openLeads: 44, maxOpen: 50, process: "Kosmo" },
  { id: "u-3", name: "Aman Verma", initials: "AV", status: "wrap_up", forMin: 2, calls: 35, talkMin: 98, conversions: 2, openLeads: 29, maxOpen: 50, process: "Kosmo" },
  { id: "u-4", name: "Neha Joshi", initials: "NJ", status: "on_call", forMin: 7, calls: 39, talkMin: 133, conversions: 5, openLeads: 41, maxOpen: 50, process: "Veda" },
  { id: "u-5", name: "Sahil Khan", initials: "SK", status: "break", forMin: 11, calls: 28, talkMin: 77, conversions: 1, openLeads: 22, maxOpen: 40, process: "Veda" },
  { id: "u-6", name: "Meera Pillai", initials: "MP", status: "available", forMin: 0, calls: 44, talkMin: 120, conversions: 3, openLeads: 35, maxOpen: 50, process: "Sprout" },
  { id: "u-7", name: "Vikram Singh", initials: "VS", status: "on_call", forMin: 1, calls: 31, talkMin: 102, conversions: 2, openLeads: 50, maxOpen: 50, process: "Sprout" },
  { id: "u-8", name: "Tanya Gupta", initials: "TG", status: "offline", forMin: 64, calls: 12, talkMin: 31, conversions: 0, openLeads: 18, maxOpen: 40, process: "Kosmo" },
];

/** Calls per hour today (09:00 → 20:00 IST); null = hour not reached yet. */
export const CALLS_BY_HOUR: { hour: number; connected: number; attempted: number | null }[] = [
  { hour: 9, connected: 18, attempted: 41 },
  { hour: 10, connected: 34, attempted: 77 },
  { hour: 11, connected: 46, attempted: 98 },
  { hour: 12, connected: 41, attempted: 90 },
  { hour: 13, connected: 22, attempted: 51 },
  { hour: 14, connected: 39, attempted: 86 },
  { hour: 15, connected: 44, attempted: 93 },
  { hour: 16, connected: 29, attempted: 64 },
  { hour: 17, connected: 0, attempted: null },
  { hour: 18, connected: 0, attempted: null },
  { hour: 19, connected: 0, attempted: null },
];

export const FUNNEL = [
  { stage: "Leads in", count: 612 },
  { stage: "Assigned", count: 598 },
  { stage: "Connected", count: 403 },
  { stage: "Interested", count: 147 },
  { stage: "Converted", count: 23 },
];

export const SOURCES: { source: SourceKind; leads: number; connectRate: number; conversions: number; avgFirstCallMin: number }[] = [
  { source: "meta_ads", leads: 248, connectRate: 0.71, conversions: 9, avgFirstCallMin: 2.4 },
  { source: "web_form", leads: 131, connectRate: 0.78, conversions: 7, avgFirstCallMin: 1.9 },
  { source: "google_ads", leads: 96, connectRate: 0.66, conversions: 4, avgFirstCallMin: 3.1 },
  { source: "indiamart", leads: 74, connectRate: 0.52, conversions: 2, avgFirstCallMin: 6.8 },
  { source: "inbound_call", leads: 41, connectRate: 0.9, conversions: 1, avgFirstCallMin: 0.4 },
  { source: "justdial", leads: 22, connectRate: 0.45, conversions: 0, avgFirstCallMin: 9.5 },
];

export const KPIS = {
  leadsToday: 612,
  leadsDelta: 0.12,
  connectRate: 0.674,
  connectDelta: 0.031,
  conversions: 23,
  conversionsDelta: -2,
  medianFirstCallSec: 142,
  overdueCallbacks: 7,
  unassigned: 3,
};

export const PROCESSES = [
  { id: "p1", name: "Kosmo Mattress · Sales", client: "Kosmo Mattress", method: "Percentage", agents: 4, open: 143, stages: ["New", "Hot", "Warm", "Cold", "Won"], dedupe: "Phone", hours: "Mon–Sat · 09:30–19:30" },
  { id: "p2", name: "Veda Realty · Site visits", client: "Veda Realty", method: "Load-based", agents: 2, open: 63, stages: ["New", "Visit booked", "Visited", "Won"], dedupe: "Phone", hours: "All days · 10:00–20:00" },
  { id: "p3", name: "Sprout Learning · Admissions", client: "Sprout Learning", method: "Equal", agents: 2, open: 85, stages: ["New", "Demo booked", "Demo done", "Enrolled"], dedupe: "Email", hours: "Mon–Fri · 09:00–18:00" },
];

export const DIDS = [
  { number: "079 7154 4878", process: "Kosmo Mattress · Sales", direction: "Both", lastCall: 1 },
  { number: "080 4718 2200", process: "Veda Realty · Site visits", direction: "Inbound", lastCall: 9 },
  { number: "022 6930 1145", process: "Sprout Learning · Admissions", direction: "Outbound", lastCall: 4 },
];

export const WEBHOOKS = [
  { url: "https://erp.kosmo.example/crm/hooks", events: ["lead.converted", "call.completed"], ok: true, lastMin: 3, rate: 0.998 },
  { url: "https://hooks.slack.example/T0/B0", events: ["lead.created"], ok: true, lastMin: 1, rate: 1 },
  { url: "https://crm.veda.example/inbound", events: ["lead.converted"], ok: false, lastMin: 47, rate: 0.62 },
];

// ------------------------------------------------------------------ formatters

export function formatPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
}

export function ago(min: number): string {
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}
