// yt-kit style runtime: the context the library pieces read, and the first set of the active style.
// The host writes the style id into the render's inputProps (render-entry.mjs); an unknown or missing id is AI Studio.
import { createContext, useContext } from "react";
import { getInputProps } from "remotion";
import { getActiveStyle, setActiveStyle, tsxStyleOf, type TsxStyle } from "./styledata";

// Set at import time (the library is imported before the scene's own code runs), so even a module-level `const C = PALETTE.accent`
// in the scene sees the right colour. tsx-root sets it again from its own props. No input props (a unit test) = the default.
try {
  setActiveStyle((getInputProps() as { style?: unknown } | undefined)?.style);
} catch {
  /* outside a render page: keep the default */
}

export const StyleContext = createContext<TsxStyle>(getActiveStyle());
/** The style the pieces draw with: the nearest StyleContext (tsx-root provides it). */
export const useStyle = (): TsxStyle => useContext(StyleContext);
export { setActiveStyle, tsxStyleOf };
