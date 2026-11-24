export type ToonBeat = {
    startS: number;
    endS: number;
    cap: string | null;
};
export type ToonSceneSpan = {
    id: string;
    startS: number;
    endS: number;
};
export type ToonTimeline = {
    beats: readonly ToonBeat[];
    scenes: readonly ToonSceneSpan[];
};
export declare function resolveMark(mark: string | number, tl: ToonTimeline): number;
/** The refusal text for a mark that would not resolve, or null when it is fine. */
export declare function markProblem(mark: string, tl: ToonTimeline): string | null;
