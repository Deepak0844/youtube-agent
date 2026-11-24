export declare const CARTOON_STYLE_IDS: readonly ["cartoon_comic", "cartoon_anime", "cartoon_manga", "cartoon_paper", "cartoon_painted"];
export type CartoonStyleId = (typeof CARTOON_STYLE_IDS)[number];
export type CartoonModule = "comic" | "anime" | "manga" | "paper" | "painted";
export declare const isCartoonStyle: (v: unknown) => v is CartoonStyleId;
export declare const cartoonStyleModule: (id: CartoonStyleId) => CartoonModule;
