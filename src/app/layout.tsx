import type { Metadata, Viewport } from "next";
import { fontVariables } from "@/ui/fonts";
import { themeScript } from "@/ui/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { template: "%s · YT Studio", default: "YT Studio" },
  description: "YT Studio",
  icons: { apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "YT Studio", statusBarStyle: "default" },
};

// Browser/title-bar colour follows the system theme (the app's own toggle can't be known this early).
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "white" },
    { media: "(prefers-color-scheme: dark)", color: "black" },
  ],
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
