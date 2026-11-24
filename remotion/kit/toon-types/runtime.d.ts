import type { ToonTimeline } from "./time";
export type ToonRuntime = {
    /** window.Short of cartoon-shorts: T, ups, E, tr, camera, during, shake, ... */
    short: any;
    /** window.FX: set pieces (burst, rays, popIn, skyline, ...) */
    FX: any;
    /** window.Toon: the puppet class plus P (poses), mix, track, cycle, ... */
    Toon: any;
    win: Record<string, any>;
    /** Wires presets, scenes, captions and grain once everything is drawn; resolves when the first frame can be shown. */
    start(fonts?: string[]): Promise<void>;
    seek(t: number): void;
};
/** cartoon-shorts' TIMELINE from the app's beats: line i = beat i. */
export declare function upstreamTimeline(tl: ToonTimeline): {
    total: number;
    scenes: {
        id: string;
        start: number;
        end: number;
    }[];
    lines: {
        i: number;
        scene: string;
        t: number;
        d: number;
        cap: string | null;
    }[];
};
export declare function createToonRuntime(tl: ToonTimeline, doc: Document): ToonRuntime;
