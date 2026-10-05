/**
 * Page guards for server components: signed in + allowed to see this page.
 * Not signed in → /login. Signed in but not allowed → 404 (app/not-found.tsx),
 * identical to a URL that doesn't exist, so typing a module's URL reveals
 * nothing about it (SECURITY.md §3.3).
 */
import { notFound, redirect } from "next/navigation";
import { getSession, type SessionContext } from "@/lib/auth/session";
import { navFor, type Screen } from "@/lib/auth/rbac";

export type Page = Screen;

export async function requirePage(page: Page): Promise<SessionContext> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!navFor(session.actor).includes(page)) notFound();
  return session;
}
