/**
 * Agent status labels and colours, shared by server and client components
 * (a plain module — values exported from a "use client" file can't be read
 * in server components).
 */
import type { AgentStatus } from "@/lib/ui/sample-data";

export const STATUS_META: Record<AgentStatus, { label: string; dot: string }> = {
  available: { label: "Available", dot: "bg-teal" },
  on_call: { label: "On call", dot: "bg-ember" },
  wrap_up: { label: "Wrap-up", dot: "bg-amber" },
  break: { label: "Break", dot: "bg-ink-4" },
  offline: { label: "Offline", dot: "bg-ink-3" },
};

/** Lead source kinds → labels (Floor, Reports). */
export const SOURCE_LABEL: Record<string, string> = {
  meta_ads: "Meta Ads", web_form: "Website", indiamart: "IndiaMART", justdial: "Justdial", inbound_call: "Inbound call",
  csv: "CSV import", google_ads: "Google Ads", sheet: "Google Sheet", api: "API", manual: "Manual",
};
