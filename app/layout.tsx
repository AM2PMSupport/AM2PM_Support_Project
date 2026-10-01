import type { Metadata } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

// Characterful grotesk for UI text; monospace for phones, timers and counts.
const sans = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: { default: "AM2PM CRM", template: "%s · AM2PM CRM" },
  description: "Multi-client call-center CRM by AM2PM Support",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
