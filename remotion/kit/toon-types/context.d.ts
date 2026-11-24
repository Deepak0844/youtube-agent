import type { ToonTimeline } from "./time";
import type { CartoonStyleId } from "./styles";
/** One series character: the puppet options cartoon-shorts' `Toon` accepts, plus a name and a one-line role. */
export type ToonCharacter = {
    name: string;
    role: string;
    style: CartoonStyleId;
    options: Record<string, string | number | boolean | null>;
};
/** What the host passes to a cartoon scene: the beats (current narration), the series cast and the frame shape. */
export type ToonInput = {
    timeline: ToonTimeline;
    cast: ToonCharacter[];
    orientation: "portrait" | "landscape";
};
export declare const ToonContext: import("react").Context<ToonInput | null>;
