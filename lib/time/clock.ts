/**
 * Analog clock maths for the login-page watch — pure, no I/O.
 *
 * IST is a fixed UTC+05:30 with no daylight saving, so wall-clock IST is
 * epoch ms shifted by a constant; no Intl call per animation frame.
 * Angles are degrees clockwise from 12 o'clock. Each hand includes the
 * fraction of the smaller units so the hour hand sits between numerals the
 * way a real movement does (e.g. 6:30 → hour hand halfway to 7).
 */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface HandAngles {
  hour: number;
  minute: number;
  second: number;
}

/** @param smooth true → second hand sweeps (ms included); false → ticks once a second. */
export function handAngles(epochMs: number, offsetMs = IST_OFFSET_MS, smooth = true): HandAngles {
  const DAY = 86_400_000;
  const ms = (((epochMs + offsetMs) % DAY) + DAY) % DAY; // ms since local midnight
  const sec = smooth ? ms / 1000 : Math.floor(ms / 1000);
  const s = sec % 60;
  const m = (sec / 60) % 60;
  const h = (sec / 3600) % 12;
  return { hour: h * 30, minute: m * 6, second: s * 6 };
}

/**
 * Server clock offset from one round trip (NTP-style, half the RTT assumed
 * each way). Returns 0 when the sample is too slow to trust.
 */
export function clockOffset(serverMs: number, sentAt: number, receivedAt: number, maxRttMs = 3_000): number {
  const rtt = receivedAt - sentAt;
  if (!Number.isFinite(serverMs) || rtt < 0 || rtt > maxRttMs) return 0;
  return serverMs + rtt / 2 - receivedAt;
}
