export declare const CARTOON_STYLE_IDS: readonly ["cartoon_comic", "cartoon_anime", "cartoon_manga", "cartoon_paper", "cartoon_painted"];
export type CartoonStyleId = (typeof CARTOON_STYLE_IDS)[number];
export type CartoonModule = "comic" | "anime" | "manga" | "paper" | "painted";
export declare const isCartoonStyle: (v: unknown) => v is CartoonStyleId;
export declare const cartoonStyleModule: (id: CartoonStyleId) => CartoonModule;
/** The page look of each style (cartoon-shorts' short.html of its example): palette, background and the extra css it adds to core.css. */
export type CartoonLook = {
    palette: Record<string, string>;
    bg: string;
    css: string;
};
export declare const CARTOON_LOOKS: Record<CartoonModule, CartoonLook>;
