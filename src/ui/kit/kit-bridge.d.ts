import type { FC } from "react";
import type { Scene, SceneDoc } from "@/shared/scene";

export type KitVideoProps = {
  doc: SceneDoc;
  seed?: string;
  resolveAsset?: (id: string) => string;
  assets?: Record<string, string>;
  audioSrc?: string;
  captions?: Array<{ word: string; startS: number; endS: number; estimated?: boolean }>;
  fps?: number;
  title?: string;
};
export const KitVideo: FC<KitVideoProps>;
export const KitScene: FC<{ scene: Scene; resolveAsset?: (id: string) => string; fps?: number }>;
