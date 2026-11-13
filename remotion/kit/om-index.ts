// Bundle entry of an OpenMontage render (render-entry.mjs --om / --om-stills). Registers OpenMontage's own Root (om/Root.tsx,
// patched to the Explainer composition only), so the scene list draws exactly as OpenMontage's renderer draws it.
// Imports nothing else of the kit.
import { registerRoot } from "remotion";
import { Root } from "./om/Root";

registerRoot(Root);
