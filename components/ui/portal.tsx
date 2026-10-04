"use client";

/**
 * Renders pop-ups, drawers and dialogs at <body> level.
 *
 * A `fixed` element's z-index only counts inside its nearest stacking
 * context. The sidebar is `sticky`, and lists fade with `opacity` while
 * loading; both create stacking contexts, so a menu inside them was painted
 * UNDER the page (e.g. Floor's funnel bars over the workspace menu). At body
 * level the overlay's z-index is always the page's.
 *
 * Only mounted after a user action (menus/drawers open on click), so
 * `document` exists; the guard keeps an accidental server render harmless.
 */
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
