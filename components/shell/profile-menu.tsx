"use client";

/**
 * Profile panel, opened from the avatar at the bottom of the rail: who you
 * are, your role in THIS workspace, and Sign out. Switching workspace lives in
 * the top bar (components/shell/workspace-switcher.tsx), next to the screen
 * title, so the current workspace is always in view.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { LogOut } from "lucide-react";

export function ProfileMenu({
  user,
  workspace,
  onClose,
}: {
  user: { name: string; initials: string; roleLabel: string };
  workspace: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return (
    <div ref={ref} role="dialog" aria-label="Profile" className="fixed bottom-4 left-[84px] z-50 w-[280px] overflow-hidden rounded-lg border border-rule bg-sheet text-ink shadow-[0_18px_50px_-12px_rgba(21,23,28,0.35)]">
      <div className="flex items-center gap-3 border-b border-rule p-4">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-[14px] font-semibold text-sheet">{user.initials}</span>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">{user.name}</div>
          <div className="truncate text-[12px] text-ink-3">{user.roleLabel} · {workspace}</div>
        </div>
      </div>
      <div className="p-2">
        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            router.replace("/login");
            router.refresh();
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-[13px] text-ink-2 hover:bg-paper"
        >
          <LogOut size={15} /> Sign out
        </button>
      </div>
    </div>
  );
}
