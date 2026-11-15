import type { MetadataRoute } from "next";

// Makes the app installable (Chrome/Edge "Install app", Safari "Add to Dock"). No service worker on purpose: every job runs on
// the owner's machine, so an offline shell would show a dead app. The manifest and /icons are public paths (lib/auth/policy.ts).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "YT Studio",
    short_name: "YT Studio",
    description: "YT Studio",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
