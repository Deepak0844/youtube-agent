import type { NextConfig } from "next";

// CSP (Doc 2 §9.5). No nonces: prerendered shells (cacheComponents) cannot carry one, so scripts use 'unsafe-inline';
// everything else stays strict. 'unsafe-eval' is dev only (React debugging).
const isDev = process.env.NODE_ENV !== "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      {
        // Signed media files are data, never pages: nothing in them may run or load anything (later entry wins over the one above).
        source: "/api/media/:path*",
        headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; sandbox" }],
      },
    ];
  },
  /* config options here */
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // A stray ~/package-lock.json made Turbopack watch the whole home folder (dev reloaded non-stop on any file change there).
    root: process.cwd(),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
