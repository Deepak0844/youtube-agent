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
  // Paper and light: soft documentary captions, paper grain over the whole frame.
  paper: {
    palette: { ink: "#0b1020", paper: "#f7eedb", gold: "#ffd97a" },
    bg: "#05070f",
    css: `#cap{z-index:10;font:900 76px/1.04 'Fraunces','Noto Sans Devanagari','Noto Sans Tamil','Noto Sans Telugu','Noto Sans Kannada','Noto Sans Malayalam',serif;text-transform:none;letter-spacing:0;color:#fbf6ea;-webkit-text-stroke:0;text-shadow:0 4px 18px rgba(0,0,0,.85),0 2px 3px rgba(0,0,0,.9);filter:none}#cap b{color:var(--gold);font-style:italic;font-weight:900}#paper{position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;opacity:.35;background-size:512px 512px}#vig{background:radial-gradient(ellipse 80% 62% at 50% 44%,transparent 50%,rgba(0,0,0,.6) 100%)}#grain{opacity:.06}`,
  },
  // Painted storybook look: warm paper, soft brown ink (never black), rounded type.
  painted: {
    palette: { ink: "#4a3426", cream: "#fbf3e2", gold: "#ffd36b", red: "#d8403a" },
    bg: "#f1dfbd",
    css: `#v{font-family:Nunito,sans-serif}#cap{z-index:10;top:1370px;left:60px;right:120px;font:900 66px/1.08 Nunito,'Noto Sans Devanagari','Noto Sans Tamil','Noto Sans Telugu','Noto Sans Kannada','Noto Sans Malayalam',sans-serif;text-transform:none;letter-spacing:0;color:#fffaf0;-webkit-text-stroke:14px var(--ink);paint-order:stroke fill;filter:drop-shadow(0 6px 0 rgba(74,52,38,.35))}#cap b{color:var(--gold);font-weight:900}#grain{opacity:.06}#paper{position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;opacity:.18;background-size:512px 512px}#vig{background:radial-gradient(ellipse 85% 65% at 50% 45%,transparent 55%,rgba(60,30,10,.35) 100%)}.dish{font:italic 900 150px/.95 Fraunces,serif;color:var(--cream);-webkit-text-stroke:14px var(--ink);paint-order:stroke fill;filter:drop-shadow(0 10px 0 rgba(42,70,110,.45))}.stat{width:280px;height:170px;background:var(--cream);border:6px solid var(--ink);border-radius:34px;box-shadow:0 10px 0 rgba(42,70,110,.35);display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--ink)}.stat b{font:900 70px/1 Fraunces,serif}.stat b i{font-style:normal;color:var(--red)}.stat small{font:800 26px Nunito;opacity:.8}.step{display:inline-flex;align-items:center;gap:20px;background:var(--cream);border:6px solid var(--ink);border-radius:60px;padding:10px 34px 10px 12px;box-shadow:0 8px 0 rgba(74,52,38,.3);color:var(--ink)}.step i{width:84px;height:84px;border-radius:50%;background:var(--red);color:var(--cream);font:900 56px/74px Fraunces,serif;text-align:center;font-style:normal;border:5px solid var(--ink)}.step span{font:900 46px Nunito}.tip{font:italic 900 72px/1 Fraunces,serif;color:var(--gold);-webkit-text-stroke:12px var(--ink);paint-order:stroke fill}.recap{background:var(--cream);border:6px solid var(--ink);border-radius:36px;padding:18px 30px 22px;text-align:center;color:var(--ink);box-shadow:0 10px 0 rgba(74,52,38,.3)}.recap b{display:block;font:italic 900 96px/1.05 Fraunces,serif}.recap .row{display:flex;justify-content:center;gap:34px;font:900 42px Nunito;margin-top:6px}.recap .row i{font-style:normal;color:var(--red)}`,
  },
};

/** What the New video / Series screens say about each cartoon style (cartoon-shorts' own style guides, in a line each). */
export const CARTOON_INFO: Record<CartoonStyleId, { label: string; mood: string; bestFor: string }> = {
  cartoon_comic: { label: "Comic", mood: "Bold outlines, puppets, sound words and speed lines on a night-blue page.", bestFor: "Explainers, jokes, how things work" },
  cartoon_anime: { label: "Anime", mood: "Soft cel shading, big eyes, focus lines, sparkles and bokeh.", bestFor: "Emotional moments, waiting and relief, small personal wins" },
  cartoon_manga: { label: "Manga", mood: "Thick ink, huge grins, hatching and sound-effect lettering.", bestFor: "Rivalries, big vows, loud comedy" },
  cartoon_paper: { label: "Paper and light", mood: "Cut-paper layers, glowing light rays and backlit silhouettes.", bestFor: "Memories, tributes, history, quiet turning points" },
  cartoon_painted: { label: "Painted storybook", mood: "Hand-painted meadows, a warm kitchen and glossy food.", bestFor: "Recipes, cosy explainers, travel, family topics" },
};
