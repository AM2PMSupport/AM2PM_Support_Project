/**
 * Page guards for server components: signed in + allowed to see this page.
 * Not signed in → /login. Signed in but not allowed → the role's home page.
 */
import { redirect } from "next/navigation";
import { getSession, type SessionContext } from "@/lib/auth/session";
import { homeFor, navFor } from "@/lib/auth/rbac";

export type Page = "console" | "leads" | "calls" | "dashboard" | "admin";

export async function requirePage(page: Page): Promise<SessionContext> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!navFor(session.actor).includes(page)) redirect(homeFor(session.actor));
  return session;
}
