"use client";

/**
 * Email + password sign-in form. Posts to /api/auth/login, which sets the
 * HttpOnly session cookie; the password is never stored client-side.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Eye, EyeOff, KeyRound, Mail } from "lucide-react";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const body = (await res.json()) as { home?: string };
        router.replace(body.home ?? "/console");
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? "Sign-in failed. Try again.");
    } catch {
      setError("Network error. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <label className="flex h-12 items-center gap-2 rounded-md border border-rule bg-sheet px-3 text-ink-3 focus-within:border-ink">
        <Mail size={16} />
        <input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@am2pmsupport.com"
          aria-label="Email"
          className="h-full flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-4"
        />
      </label>
      <label className="flex h-12 items-center gap-2 rounded-md border border-rule bg-sheet px-3 text-ink-3 focus-within:border-ink">
        <KeyRound size={16} />
        <input
          type={show ? "text" : "password"}
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          className="h-full flex-1 bg-transparent font-mono text-[14px] text-ink outline-none placeholder:font-sans placeholder:text-ink-4"
        />
        <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} className="text-ink-4 hover:text-ink">
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </label>

      {error && (
        <p role="alert" className="rounded-md border-l-[3px] border-ember bg-ember-wash px-3 py-2 text-[13px] text-ember-ink">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !email || !password}
        className="mt-1 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-ink text-[14px] font-semibold text-sheet transition hover:bg-ink-2 disabled:cursor-not-allowed disabled:bg-rule-strong disabled:text-ink-3"
      >
        {busy ? "Signing in…" : "Sign in"}
        {!busy && <ArrowRight size={16} />}
      </button>
    </form>
  );
}
