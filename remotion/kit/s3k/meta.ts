// Facts about the demo compositions that the registry needs WITHOUT loading three.js (the registry imports this file eagerly; the 3D code is lazy).
export const S3K_EXAMPLES = { tunnel: { seconds: 20 }, reclamation: { seconds: 14 } } as const;
import type { ModelResolver } from "../../../src/shared/scene3d/resolver";
/** One story beat with its REAL time in the narration (seconds). */
export type SceneBeat = { id: string; text: string; from: number; to: number };
/** The props the host gives the default-exported scene component of an AI-written scene (Author.tsx). */
export type SceneProps = { resolver: ModelResolver; beats: readonly SceneBeat[]; durationS: number };
export type S3kExample = keyof typeof S3K_EXAMPLES;
export const S3K_FPS = 30;
/** `finish`: "full" (default), "fast" (no AO / depth of field) or "off" (plain render, for debugging). */
export type S3kDemoProps = { example?: S3kExample; finish?: "full" | "fast" | "off" };
export const s3kFrames = (p: S3kDemoProps): number => Math.round(S3K_EXAMPLES[p.example ?? "tunnel"].seconds * S3K_FPS);
