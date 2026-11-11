// Theme choice (spec 2026-11-12 §4.5): System / Light / Dark, kept in a cookie. "system" means no data-theme on <html>,
// so tokens.css follows the Mac setting. The tiny head script applies a saved light/dark choice before first paint
// (the root layout is prerendered under cacheComponents, so it cannot read the cookie on the server).
export type ThemeChoice = "system" | "light" | "dark";
export const THEME_COOKIE = "ytstudio-theme";

export function parseTheme(v: string | undefined): ThemeChoice {
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export const themeScript = `try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark)(?:;|$)/);if(m)document.documentElement.setAttribute("data-theme",m[1])}catch(e){}`;

/** Browser only: save the choice for a year and apply it now. */
export function applyTheme(choice: ThemeChoice): void {
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
}

/** Browser only: the saved choice. */
export function readTheme(): ThemeChoice {
  const m = new RegExp(`(?:^|; )${THEME_COOKIE}=([a-z]+)`).exec(document.cookie);
  return parseTheme(m?.[1]);
}
