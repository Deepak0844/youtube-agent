// The five cartoon looks of cartoon-shorts. A cartoon video's style id is one of these (they are not in the ten yt-kit looks).
export const CARTOON_STYLE_IDS = ["cartoon_comic", "cartoon_anime", "cartoon_manga", "cartoon_paper", "cartoon_painted"] as const;
export type CartoonStyleId = (typeof CARTOON_STYLE_IDS)[number];
export type CartoonModule = "comic" | "anime" | "manga" | "paper" | "painted";

export const isCartoonStyle = (v: unknown): v is CartoonStyleId => typeof v === "string" && (CARTOON_STYLE_IDS as readonly string[]).includes(v);
export const cartoonStyleModule = (id: CartoonStyleId): CartoonModule => id.slice("cartoon_".length) as CartoonModule;

/** The page look of each style (cartoon-shorts' short.html of its example): palette, background and the extra css it adds to core.css. */
export type CartoonLook = { palette: Record<string, string>; bg: string; css: string };
const COMIC_PALETTE = { ink: "#17111b", paper: "#fbf3e4", gold: "#ffb81c", red: "#e8343d", sky: "#4fb3ff" };
export const CARTOON_LOOKS: Record<CartoonModule, CartoonLook> = {
  comic: {
    palette: COMIC_PALETTE,
    bg: "#1b1630",
    css: `.word{font:400 150px/1 var(--comic);letter-spacing:.03em;color:#fff;-webkit-text-stroke:14px var(--ink);paint-order:stroke fill;filter:drop-shadow(8px 10px 0 var(--ink))}`,
  },
  // Anime look: soft night blues that turn to warm pink and gold.
  anime: {
    palette: { ink: "#2b1a14", paper: "#fff6ec", gold: "#ffd166", red: "#e8546b", sky: "#8ec5ff" },
    bg: "#1d1a3a",
    css: `#cap{-webkit-text-stroke:16px #2b1a3a}#cap b{color:#ffd166}`,
  },
  // the other looks arrive with their style (paper, painted); until then they draw like comic
  // Manga look: ink black, paper white, a hot red and gold.
  manga: { palette: { ink: "#151214", paper: "#fbf3e4", gold: "#ffc93c", red: "#e23b2e", sky: "#4fb3ff" }, bg: "#151214", css: `.scene svg{display:block}` },
  paper: { palette: COMIC_PALETTE, bg: "#1b1630", css: "" },
  painted: { palette: COMIC_PALETTE, bg: "#1b1630", css: "" },
};
