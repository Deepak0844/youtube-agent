// The AI video models each registry provider offers, by id. Pure data for the Providers page and the route check; the adapters hold the full
// capabilities (a test keeps the two lists equal, so they cannot drift apart).
export const VIDEO_MODEL_IDS: Readonly<Record<string, readonly string[]>> = {
  seedance_video: ["dreamina-seedance-2-5-260628", "dreamina-seedance-2-0-260128", "dreamina-seedance-2-0-fast-260128", "dreamina-seedance-2-0-mini-260615"],
  kling_video: ["kling-3.0", "kling-4.0"],
  veo_video: ["veo-3.1-generate-001", "veo-3.1-fast-generate-001", "veo-3.1-lite-generate-001"],
};

export const isVideoProvider = (id: string): boolean => Object.hasOwn(VIDEO_MODEL_IDS, id);
export const isVideoModel = (provider: string, model: string): boolean => Object.hasOwn(VIDEO_MODEL_IDS, provider) && VIDEO_MODEL_IDS[provider]!.includes(model);
