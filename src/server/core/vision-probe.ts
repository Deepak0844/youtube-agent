import { deflateSync } from "node:zlib";

// The "Test image reading" probe: a tiny picture drawn in code (a red square with a white circle), so no file and no
// download is involved, plus the check that an answer really describes it.

export const PROBE_QUESTION = "What colour is the square and what shape is inside it? Answer in 6 words.";
const SIZE = 64;

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A 64x64 RGB PNG: solid red, white filled circle in the middle. */
export function makeProbePng(): Buffer {
  const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE); // each row: filter byte 0, then RGB pixels
  const c = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 3 + 1);
    for (let x = 0; x < SIZE; x++) {
      const white = (x - c) ** 2 + (y - c) ** 2 <= 20 ** 2;
      const o = row + 1 + x * 3;
      raw[o] = 255;
      raw[o + 1] = white ? 255 : 0;
      raw[o + 2] = white ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** True when the answer names the colour red and the square or the circle. A wrong-looking answer is not a pass. */
export function visionOk(answer: string): boolean {
  const a = String(answer).toLowerCase();
  return /\bred\b/.test(a) && /\b(square|circle|round|disc|disk)s?\b/.test(a);
}

/** The model's words as shown on the page: control characters and markup characters removed, at most 120 characters. */
export function clipAnswer(answer: string): string {
  const t = String(answer).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}
