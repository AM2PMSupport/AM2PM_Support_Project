/**
 * First paint for any route before its layout is ready — e.g. opening the app
 * cold while the (app) layout checks the session. Nothing of the shell exists
 * yet, so this is the full-page AM2PM loader; once the shell is up, screen
 * changes use the per-screen skeletons under app/(app)/.
 */
import { BrandLoader } from "@/components/ui/brand-loader";

export default function Loading() {
  return <BrandLoader label="Loading AM2PM CRM" />;
}
