// Bundle entry of a TSX render (render-entry.mjs --tsx / --tsx-stills). Imports nothing of the kit: the only scene code in
// this bundle is the checked /in/video.tsx, reached through the "tsx-scene" alias set by render-entry.mjs.
import { registerRoot } from "remotion";
import { TsxRoot } from "./tsx-root";

registerRoot(TsxRoot);
