// The five cartoon looks of cartoon-shorts. A cartoon video's style id is one of these (they are not in the ten yt-kit looks).
export const CARTOON_STYLE_IDS = ["cartoon_comic", "cartoon_anime", "cartoon_manga", "cartoon_paper", "cartoon_painted"] as const;
export type CartoonStyleId = (typeof CARTOON_STYLE_IDS)[number];
export type CartoonModule = "comic" | "anime" | "manga" | "paper" | "painted";

export const isCartoonStyle = (v: unknown): v is CartoonStyleId => typeof v === "string" && (CARTOON_STYLE_IDS as readonly string[]).includes(v);
export const cartoonStyleModule = (id: CartoonStyleId): CartoonModule => id.slice("cartoon_".length) as CartoonModule;
