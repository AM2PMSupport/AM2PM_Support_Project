/**
 * Shared labels and column definitions for the Leads screen. Column choice
 * and page size are per-viewer conveniences kept in localStorage; filters
 * live in the URL (shareable, and what a saved filter stores).
 */
export const SOURCE_LABEL: Record<string, string> = {
  meta_ads: "Meta Ads",
  web_form: "Website",
  indiamart: "IndiaMART",
  justdial: "Justdial",
  inbound_call: "Inbound call",
  csv: "CSV import",
  google_ads: "Google Ads",
  sheet: "Google Sheet",
  api: "API",
  manual: "Manual",
};

export const FLAG_LABEL: Record<string, string> = {
  mine: "My leads",
  unassigned: "Unassigned",
  assigned: "Assigned",
  not_called: "Not called yet",
  touched: "Called at least once",
  callback_overdue: "Callback overdue",
  callback_today: "Callback due today",
  has_callback: "Has a callback",
  no_callback: "No callback scheduled",
  re_enquired: "Re-enquired",
  stale_7d: "No activity in 7+ days",
  has_email: "Has email",
  no_email: "No email",
  no_phone: "No phone number",
  converted_today: "Converted today",
};
/** Flags that only make sense for people who see other people's leads. */
export const OWNER_FLAGS = new Set(["mine", "unassigned", "assigned"]);

export const SORT_LABEL: Record<string, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  name: "Name A–Z",
  callback: "Next callback",
  activity: "Last activity",
};

export type ColumnKey =
  | "phone"
  | "email"
  | "process"
  | "source"
  | "campaign"
  | "stage"
  | "owner"
  | "outcome"
  | "attempts"
  | "callback"
  | "activity"
  | "city"
  | "created";

export const COLUMNS: { key: ColumnKey; label: string; default: boolean }[] = [
  { key: "phone", label: "Phone", default: true },
  { key: "email", label: "Email", default: false },
  { key: "process", label: "Process", default: true },
  { key: "source", label: "Source", default: true },
  { key: "campaign", label: "Campaign", default: false },
  { key: "stage", label: "Stage", default: true },
  { key: "owner", label: "Lead owner", default: true },
  { key: "outcome", label: "Last outcome", default: true },
  { key: "attempts", label: "Attempts", default: false },
  { key: "callback", label: "Next callback", default: true },
  { key: "activity", label: "Last activity", default: false },
  { key: "city", label: "City", default: false },
  { key: "created", label: "Age", default: true },
];

export const DEFAULT_COLUMNS = COLUMNS.filter((c) => c.default).map((c) => c.key);

export function relTime(iso: string, now: number) {
  const m = Math.round((new Date(iso).getTime() - now) / 60000);
  const a = Math.abs(m);
  const t = a < 60 ? `${a}m` : a < 1440 ? `${Math.floor(a / 60)}h` : `${Math.floor(a / 1440)}d`;
  return m < 0 ? `overdue ${t}` : `in ${t}`;
}

export function age(iso: string, now: number) {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export function ago(iso: string, now: number) {
  return `${age(iso, now)} ago`;
}
