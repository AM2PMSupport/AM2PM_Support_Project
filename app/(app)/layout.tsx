/**
 * Authenticated app shell: ink rail + paper workspace.
 * No valid session cookie → redirect to /login. Screens still render
 * fictional sample data until their read/write APIs are wired (T1.33+).
 * Queue safety net (lib/queue/health.ts): after each page the timer work may
 * run from traffic while QStash is degraded, and Super Admins see a banner.
 */
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { navFor } from "@/lib/auth/rbac";
import { Sidebar } from "@/components/shell/sidebar";
import { WorkspaceProvider } from "@/components/shell/workspace-switcher";
import { ROLE_LABEL } from "@/lib/auth/rbac";
import { queueDegraded, queueState } from "@/lib/queue/health";
import { scheduleFallbackTick } from "@/lib/queue/fallback-tick";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { name, role } = session.actor;
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  scheduleFallbackTick();
  const queue = role === "super_admin" && (await queueDegraded()) ? await queueState() : null;

  return (
    <div className="flex min-h-dvh">
      <Sidebar user={{ name, initials, roleLabel: ROLE_LABEL[role] }} workspace={session.tenantName} nav={navFor(session.actor)} canTakeCalls={role === "agent" || role === "process_coordinator"} />
      {/* Gives every screen's top bar the workspace name for the switcher. */}
      <WorkspaceProvider workspace={session.tenantName}>
        <div className="flex min-w-0 flex-1 flex-col">
          {queue && (
            <div role="alert" className="shrink-0 border-b border-ember/40 bg-ember-wash px-6 py-2 text-[12.5px] text-ember-ink">
              <span className="font-semibold">Background queue is refusing messages</span> since{" "}
              {new Date(queue.since).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: session.timezone })} — {queue.reason}. Calls and leads are still saved and processed by the backup path, more slowly. Check the QStash plan and billing in Upstash.
            </div>
          )}
          {children}
        </div>
      </WorkspaceProvider>
    </div>
  );
}
