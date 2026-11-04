import { z } from "zod";

// Only these two licences are ever allowed in the catalogue. A test fails if anything else sneaks in.
export const ALLOWED_LICENSES = ["CC0-1.0", "Public Domain"] as const;

export const CATEGORIES = [
  "vehicles",
  "buildings",
  "nature",
  "animals",
  "people",
  "props",
  "space",
  "hdri",
  "texture",
] as const;

const vec3 = z.object({ x: z.number().positive(), y: z.number().positive(), z: z.number().positive() });

const base = {
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
  name: z.string().min(1),
  category: z.enum(CATEGORIES),
  tags: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
  source: z.string().min(1),
  url: z.url(),
  download_url: z.url(),
  author: z.string().min(1),
  license: z.enum(ALLOWED_LICENSES),
  license_evidence: z.string().min(8),
  file: z.string().regex(/^[A-Za-z0-9_.-]+\.(glb|hdr|jpg|png)$/),
  // sha256 of the file in assets3d/files. source_sha256 is of the original download (authoritative);
  // for packed models it is over the .gltf plus its extra files, otherwise it equals sha256.
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
};

export const ModelEntry = z.object({
  ...base,
  kind: z.literal("model"),
  bounds_m: vec3, // real-world size in metres (estimated)
  up_axis: z.enum(["y", "z"]),
  default_scale: z.number().positive(), // multiply the file's own units by this to get metres
  pivot: z.enum(["bottom", "center"]),
});

// hdri = sky/light map, texture = seamless ground/rock/sand/water surface
export const MapEntry = z.object({
  ...base,
  kind: z.enum(["hdri", "texture"]),
  tile_m: z.number().positive().optional(), // textures: real-world size of one tile in metres
});

export const Entry = z.discriminatedUnion("kind", [ModelEntry, MapEntry]);
export const Manifest = z.object({ version: z.literal(1), entries: z.array(Entry) });

export type Entry3d = z.infer<typeof Entry>;
export type ModelEntry3d = z.infer<typeof ModelEntry>;
export type Manifest3d = z.infer<typeof Manifest>;
