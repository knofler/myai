import type { Metadata } from "next";
import { branding } from "@/app/lib/branding";
import "./globals.css";

export const metadata: Metadata = {
  title: branding.name,
  description: branding.description,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
