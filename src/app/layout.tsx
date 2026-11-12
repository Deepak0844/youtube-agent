import type { Metadata } from "next";
import { fontVariables } from "@/ui/fonts";
import { themeScript } from "@/ui/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { template: "%s · YT Studio", default: "YT Studio" },
  description: "YT Studio",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the head script may set data-theme on <html> before React hydrates.
    <html lang="en" className={`${fontVariables} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* suppressHydrationWarning: some browser extensions (a pop-up blocker was seen) rewrite this tag (src added, body
            emptied); without it the root fails to hydrate and the dev server reloads the page in a loop. */}
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
