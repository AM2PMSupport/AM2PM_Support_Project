/**
 * Authenticated app shell: ink rail + paper workspace.
 *
 * TODO(T1.11): require a session here (redirect to /login) once Auth.js is
 * wired. Until then the screens render fictional sample data only.
 */
import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/sidebar";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
