import type { Metadata } from "next";
import { Console } from "@/components/console/console";
import { Topbar } from "@/components/shell/topbar";

export const metadata: Metadata = { title: "Console" };

export default function ConsolePage() {
  return (
    <div className="flex h-dvh flex-col">
      <Topbar title="Console" subtitle="Your queue · click-to-call rings your phone first" />
      <Console />
    </div>
  );
}
