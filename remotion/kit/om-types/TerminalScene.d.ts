/**
 * TerminalScene — animated terminal with typed commands and scrolling output.
 *
 * Each "step" is either:
 *   { kind: "cmd", text: "git clone ...", typeSpeed?: number }  — typed char-by-char with prompt
 *   { kind: "out", text: "cloning into 'OpenMontage'..." }       — reveals instantly
 *   { kind: "pause", seconds: number }                            — silent dwell
 *   { kind: "pill", text: "Piper TTS installed", color?: string } — floating badge
 *
 * Steps execute in order at the specified durations. Terminal auto-scrolls when
 * it fills up.
 */
export type TerminalStep = {
    kind: "cmd";
    text: string;
    typeSpeed?: number;
    holdSeconds?: number;
} | {
    kind: "out";
    text: string;
    holdSeconds?: number;
} | {
    kind: "pause";
    seconds: number;
} | {
    kind: "pill";
    text: string;
    color?: string;
    durationSeconds?: number;
};
interface TerminalSceneProps {
    title?: string;
    steps: TerminalStep[];
    prompt?: string;
    accentColor?: string;
    backgroundColor?: string;
}
export declare const TerminalScene: React.FC<TerminalSceneProps>;
export {};
