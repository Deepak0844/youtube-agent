// Pure timing/motion helpers (unit-tested; no Remotion imports).
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** How many items (of `total`) are visible at `frame`, one new item every `framesPer`, first at `start`. */
export function visibleCount(frame: number, framesPer: number, total: number, start = 0): number {
  if (framesPer <= 0) return total;
  return Math.max(0, Math.min(total, Math.floor((frame - start) / framesPer) + 1));
}

/** Typewriter: characters of a `length` string shown at `frame`, `framesPerChar` each, starting at `start`. */
export function typedChars(frame: number, start: number, framesPerChar: number, length: number): number {
  if (framesPerChar <= 0) return length;
  return Math.max(0, Math.min(length, Math.floor((frame - start) / framesPerChar)));
}

export type KenBurns = { zoomFrom: number; zoomTo: number; panX: number; panY: number };

/** Scale and translate (as fractions of the frame size) at `frame` of `total`. Pan eases from -pan to +pan. */
export function kenBurns(frame: number, total: number, k: KenBurns): { scale: number; x: number; y: number } {
  const t = total <= 1 ? 1 : clamp01(frame / (total - 1));
  return {
    scale: k.zoomFrom + (k.zoomTo - k.zoomFrom) * t,
    x: k.panX * (2 * t - 1),
    y: k.panY * (2 * t - 1),
  };
}

// ---- orbit ----
export type OrbitBody = { label: string; radius: number; periodS: number };
export type OrbitPreset = "solar_system" | "moon_earth" | "custom";

const PRESETS: Record<Exclude<OrbitPreset, "custom">, OrbitBody[]> = {
  solar_system: [
    { label: "Mercury", radius: 2, periodS: 4 },
    { label: "Venus", radius: 3.5, periodS: 7 },
    { label: "Earth", radius: 5, periodS: 10 },
    { label: "Mars", radius: 7, periodS: 15 },
    { label: "Jupiter", radius: 9.5, periodS: 30 },
  ],
  moon_earth: [{ label: "Moon", radius: 6, periodS: 8 }],
};

export function resolveBodies(preset: OrbitPreset, bodies: OrbitBody[] | undefined): OrbitBody[] {
  return preset === "custom" ? (bodies ?? []) : PRESETS[preset];
}

/** Position on an ellipse centred on the origin; one lap per `periodS` seconds. */
export function orbitPoint(frame: number, fps: number, periodS: number, rx: number, ry: number, phase = 0): [number, number] {
  const a = phase + (2 * Math.PI * frame) / (fps * periodS);
  return [rx * Math.cos(a), ry * Math.sin(a)];
}

// ---- map ----
/** [west, south, east, north] in degrees. */
export const REGIONS = {
  world: [-180, -58, 180, 80],
  europe: [-12, 35, 40, 71],
  north_america: [-170, 7, -50, 72],
  south_america: [-82, -56, -34, 13],
  africa: [-20, -35, 52, 38],
  asia: [25, -10, 150, 55],
  oceania: [110, -48, 180, 0],
} as const satisfies Record<string, readonly [number, number, number, number]>;
export type Region = keyof typeof REGIONS;

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360));

/** Mercator-project lon/lat into a w x h box, fitting the whole region and centring it. */
export function kitProject(region: Region, lon: number, lat: number, w: number, h: number): [number, number] {
  const [west, south, east, north] = REGIONS[region];
  const spanX = ((east - west) * Math.PI) / 180;
  const spanY = mercY(north) - mercY(south);
  const k = Math.min(w / spanX, h / spanY);
  const ox = (w - spanX * k) / 2;
  const oy = (h - spanY * k) / 2;
  return [ox + (((lon - west) * Math.PI) / 180) * k, oy + (mercY(north) - mercY(lat)) * k];
}

export function inRegion(region: Region, lon: number, lat: number): boolean {
  const [west, south, east, north] = REGIONS[region];
  return lon >= west && lon <= east && lat >= south && lat <= north;
}
