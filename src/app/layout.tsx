import type { Metadata } from "next";
import { fontVariables } from "@/ui/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "YT Studio",
  description: "YT Studio",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fontVariables} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
