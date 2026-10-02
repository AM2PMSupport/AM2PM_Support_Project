/** Signed in, but this role has no screens yet (e.g. client portal is Phase 3). */
import { Topbar } from "@/components/shell/topbar";

export default function NoAccessPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar title="Nothing here yet" />
      <div className="dotgrid flex flex-1 items-center justify-center p-10">
        <div className="panel max-w-[440px] p-6">
          <div className="eyebrow">Your role</div>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
            Your account doesn&apos;t have screens in this release. The client portal arrives in Phase 3 — ask your AM2PM
            admin if you need access sooner.
          </p>
        </div>
      </div>
    </div>
  );
}
