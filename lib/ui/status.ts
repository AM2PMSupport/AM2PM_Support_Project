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
