/**
 * Authenticated app shell: ink rail + paper workspace.
 * No valid session cookie → redirect to /login. Screens still render
 * fictional sample data until their read/write APIs are wired (T1.33+).
 */
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { navFor } from "@/lib/auth/rbac";
import { Sidebar } from "@/components/shell/sidebar";
import { WorkspaceProvider } from "@/components/shell/workspace-switcher";
import { ROLE_LABEL } from "@/lib/auth/rbac";


export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { name, role } = session.actor;
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="flex min-h-dvh">
      <Sidebar user={{ name, initials, roleLabel: ROLE_LABEL[role] }} workspace={session.tenantName} nav={navFor(session.actor)} canTakeCalls={role === "agent" || role === "process_coordinator"} />
      {/* Gives every screen's top bar the workspace name for the switcher. */}
      <WorkspaceProvider workspace={session.tenantName}>
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </WorkspaceProvider>
    </div>
  );
}
