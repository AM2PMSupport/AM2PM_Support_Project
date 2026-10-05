/**
 * Traffic-driven backup for the 5-minute timer (lib/queue/health.ts). While
 * the queue is degraded the QStash schedule that fires `tick` is not
 * delivered either, so page views keep the essential work going: after a
 * signed-in page has been sent (next/server `after`), at most one instance
 * every LOCK_S runs the tick inline — reminders, sweeps, call sync, and stuck
 * webhooks processed in place. Costs nothing while the queue is healthy (the
 * degraded flag is cached per instance).
 */
import { after } from "next/server";
import { keys, redis } from "@/lib/redis/client";
import { queueDegraded } from "@/lib/queue/health";
import { log } from "@/lib/log";

const LOCK_S = 240;

export function scheduleFallbackTick(): void {
  after(async () => {
    try {
      if (!(await queueDegraded())) return;
      const got = await redis().set(keys.fallbackTickLock(), String(Date.now()), { nx: true, ex: LOCK_S });
      if (!got) return;
      const { handlers } = await import("@/lib/jobs/handlers");
      await handlers.tick({});
      log.info("fallback tick ran from page traffic (queue degraded)");
    } catch (err) {
      log.error("fallback tick failed", { err });
    }
  });
}
