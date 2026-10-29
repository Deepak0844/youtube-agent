// Pure content sniffing for uploads (Doc 13 5.1). Magic bytes only: the file name and the declared type are never
// looked at, so "photo.png" holding JPEG bytes is a JPEG. Anything not on the allow-list is rejected with a reason
// the UI can turn into a plain message. Fails closed: when in doubt, 'unknown'.

export type SniffRejection = "svg" | "html" | "heic" | "unknown" | "video";
export type SniffResult = { kind: "image" | "audio"; mime: string } | { rejected: SniffRejection };

/** How many leading bytes callers should hand to sniff(). */
export const SNIFF_HEAD_BYTES = 4096;

const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));
const startsWith = (b: Uint8Array, sig: readonly number[]): boolean => b.length >= sig.length && sig.every((v, i) => b[i] === v);

// Markup that can run as a page. Looked for in the head of every file, so an image with HTML smuggled after its magic
// bytes (a polyglot) is refused rather than trusted.
const MARKUP = /<\s*(?:script|html|svg|iframe|body|head|!doctype|object|embed|meta|link|img\b[^>]*onerror)/i;

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "avif", "avis"]);
const M4A_BRANDS = new Set(["M4A ", "M4B "]);

function looksLikeText(head: Uint8Array): string | null {
  let i = 0;
  if (startsWith(head, [0xef, 0xbb, 0xbf])) i = 3;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  return head[i] === 0x3c /* < */ ? ascii(head, i, Math.min(head.length, i + 512)).toLowerCase() : null;
}

export function sniff(head: Uint8Array): SniffResult {
  if (head.length < 4) return { rejected: "unknown" };

  const text = looksLikeText(head);
  if (text !== null) return { rejected: /<svg|<\?xml[^>]*>\s*(?:<!doctype svg|<svg)/.test(text) ? "svg" : "html" };

  let found: SniffResult = { rejected: "unknown" };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) found = { kind: "image", mime: "image/png" };
  else if (startsWith(head, [0xff, 0xd8, 0xff])) found = { kind: "image", mime: "image/jpeg" };
  else if (ascii(head, 0, 4) === "RIFF" && head.length >= 12 && ascii(head, 8, 12) === "WEBP") found = { kind: "image", mime: "image/webp" };
  else if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") found = { kind: "image", mime: "image/gif" };
  else if (ascii(head, 0, 4) === "RIFF" && head.length >= 12 && ascii(head, 8, 12) === "WAVE") found = { kind: "audio", mime: "audio/wav" };
  else if (ascii(head, 0, 4) === "fLaC") found = { kind: "audio", mime: "audio/flac" };
  else if (ascii(head, 0, 3) === "ID3") found = { kind: "audio", mime: "audio/mpeg" };
  else if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0 && ((head[1] ?? 0) & 0x18) !== 0x08 && ((head[1] ?? 0) & 0x06) !== 0) {
    found = { kind: "audio", mime: "audio/mpeg" }; // MPEG audio frame sync (not the reserved version/layer values)
  } else if (head.length >= 12 && ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (M4A_BRANDS.has(brand)) found = { kind: "audio", mime: "audio/mp4" };
    else if (HEIC_BRANDS.has(brand)) return { rejected: "heic" };
    else return { rejected: "video" };
  } else if (ascii(head, 0, 4) === "RIFF" || startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]) || ascii(head, 0, 4) === "OggS") {
    return { rejected: ascii(head, 0, 4) === "OggS" ? "unknown" : "video" };
  }

  if ("kind" in found && found.kind === "image" && MARKUP.test(ascii(head, 0, head.length))) return { rejected: "html" };
  return found;
}

/** Plain message for a rejection, for the UI. */
export function rejectionMessage(r: SniffRejection): string {
  switch (r) {
    case "svg":
      return "SVG files are not accepted. Export the picture as PNG or JPEG.";
    case "html":
      return "This file contains web page code, so it was refused.";
    case "heic":
      return "HEIC photos are not supported. Convert the photo to JPEG or PNG and upload again.";
    case "video":
      return "Video files are not accepted here.";
    default:
      return "This file type is not accepted. Use PNG, JPEG, WebP, GIF, WAV, MP3, M4A or FLAC.";
  }
}
