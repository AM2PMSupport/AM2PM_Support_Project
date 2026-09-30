/**
 * Telephony providers available to tenants. To add a provider, implement
 * `TelephonyAdapter` under lib/providers/telephony/<name>/ and list it here.
 */
import { callerDeskAdapter } from "@/lib/providers/telephony/callerdesk/adapter";
import type { TelephonyAdapter } from "@/lib/telephony/types";

const ADAPTERS: Record<string, TelephonyAdapter> = {
  callerdesk: callerDeskAdapter,
  // myoperator: myOperatorAdapter,  // TASK.md T4.5
  // exotel: exotelAdapter,          // TASK.md T4.5
};

export function telephonyAdapter(provider: string): TelephonyAdapter | undefined {
  return ADAPTERS[provider];
}
