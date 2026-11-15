// Bundle entry of a clip render (render-entry.mjs --clip): the fixed clip composition only, no scene file.
import { registerRoot } from "remotion";
import { ClipRoot } from "./clip-root";

registerRoot(ClipRoot);
