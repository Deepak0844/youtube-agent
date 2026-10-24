// UUIDv7 (RFC 9562): 48-bit unix-ms timestamp, version 7, variant 10, 74 random bits.
// Ordering: ids sort by creation time. Within one millisecond (or if the clock steps
// backwards) we keep the last timestamp and increment the 74-bit random field by one
// (RFC 9562 method 1-style counter), so ids from one process are strictly increasing.
// Module state is just that (lastMs, lastRand); time and randomness are injectable for tests.

const RAND_BITS = 74n;
const RAND_MAX = (1n << RAND_BITS) - 1n;

let lastMs = -1;
let lastRand = 0n;

function randomBits(random: (n: number) => Uint8Array): bigint {
  let v = 0n;
  for (const b of random(10)) v = (v << 8n) | BigInt(b);
  return v & RAND_MAX;
}

export function uuidv7(
  now: number = Date.now(),
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  let ms = Math.floor(now);
  let rand: bigint;
  if (ms > lastMs) {
    rand = randomBits(random);
  } else {
    ms = lastMs;
    rand = lastRand + 1n;
    if (rand > RAND_MAX) {
      ms += 1;
      rand = randomBits(random);
    }
  }
  lastMs = ms;
  lastRand = rand;

  const randA = rand >> 62n; // top 12 bits
  const randB = rand & ((1n << 62n) - 1n); // low 62 bits
  const hex =
    BigInt(ms).toString(16).padStart(12, "0") +
    (0x7000n | randA).toString(16).padStart(4, "0") +
    ((0b10n << 62n) | randB).toString(16).padStart(16, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
