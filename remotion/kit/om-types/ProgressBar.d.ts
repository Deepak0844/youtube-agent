type ProgressAnimationStyle = "fill" | "pulse" | "step";
interface ProgressSegment {
    value: number;
    color?: string;
    label?: string;
}
interface ProgressBarProps {
    progress: number;
    label?: string;
    color?: string;
    backgroundColor?: string;
    trackColor?: string;
    showPercentage?: boolean;
    animationStyle?: ProgressAnimationStyle;
    segments?: ProgressSegment[];
    height?: number;
    borderRadius?: number;
    fontFamily?: string;
    textColor?: string;
    labelFontSize?: number;
    percentageFontSize?: number;
}
export declare const ProgressBar: React.FC<ProgressBarProps>;
export {};
