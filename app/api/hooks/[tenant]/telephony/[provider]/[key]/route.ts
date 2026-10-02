/**
 * POST|GET /api/hooks/{tenant}/telephony/{provider}/{key} — same webhook as
 * the parent route, with the secret in the PATH (current URL form). Providers
 * can't drop or rewrite it the way they do query strings. Verified by the
 * adapter (presentedWebhookKey).
 */
export { GET, POST } from "../route";
