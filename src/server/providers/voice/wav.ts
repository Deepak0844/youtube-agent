// Just enough RIFF/WAVE to measure PCM chunks and join them. A streamed header may claim a huge data size: clamp to the file.
export interface Wav { fmt: Buffer; data: Buffer; byteRate: number }

export function parseWav(b: Buffer): Wav {
  const bad = () => new Error("The voice server did not send a WAV file.");
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") throw bad();
  let fmt: Buffer | undefined;
  for (let off = 12; off + 8 <= b.length; ) {
    const id = b.toString("latin1", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === "fmt ") fmt = b.subarray(start, start + size);
    if (id === "data") {
      if (!fmt || fmt.length < 16 || fmt.readUInt32LE(8) === 0) throw bad();
      return { fmt, data: b.subarray(start, Math.min(start + size, b.length)), byteRate: fmt.readUInt32LE(8) };
    }
    off = start + size + (size & 1);
  }
  throw bad();
}

export const wavSeconds = (w: Wav): number => w.data.length / w.byteRate;

export function joinWav(parts: Wav[]): Buffer {
  const first = parts[0];
  if (!first || parts.some((p) => !p.fmt.equals(first.fmt))) throw new Error("The voice server returned chunks in different audio formats.");
  const data = Buffer.concat(parts.map((p) => p.data));
  const head = Buffer.alloc(20 + first.fmt.length + 8);
  head.write("RIFF", 0);
  head.writeUInt32LE(head.length - 8 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(first.fmt.length, 16);
  first.fmt.copy(head, 20);
  head.write("data", 20 + first.fmt.length);
  head.writeUInt32LE(data.length, 24 + first.fmt.length);
  return Buffer.concat([head, data]);
}
