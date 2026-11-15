// Draws the YT Studio icon (same shapes as src/app/favicon.ico: a timeline with a playhead) as PNGs for the PWA.
// Run: node scripts/make-pwa-icons.mjs   Output goes to public/icons/ and is committed, so this is only for redraws.
import sharp from "sharp";

const shapes = `
  <rect x="77" y="224" width="64" height="64" rx="10" fill="#fff"/>
  <rect x="173" y="224" width="64" height="64" rx="10" fill="#fff"/>
  <rect x="261" y="178" width="76" height="156" rx="22" fill="none" stroke="#fff" stroke-width="12"/>
  <rect x="369" y="224" width="64" height="64" rx="10" fill="#777"/>`;
// "any" icon: rounded black square, corners transparent. "maskable"/apple: full-bleed black, the OS cuts its own shape.
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#000"/>${shapes}</svg>`;
const bleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#000"/>${shapes}</svg>`;

const out = [
  ["icon-192.png", rounded, 192],
  ["icon-512.png", rounded, 512],
  ["icon-maskable-512.png", bleed, 512],
  ["apple-touch-icon.png", bleed, 180],
];
for (const [name, svg, size] of out) await sharp(Buffer.from(svg)).resize(size, size).png().toFile(`public/icons/${name}`);
