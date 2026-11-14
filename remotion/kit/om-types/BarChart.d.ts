interface BarDatum {
    label: string;
    value: number;
}
type BarAnimationStyle = "grow-up" | "slide-in" | "pop";
interface BarChartProps {
    data: BarDatum[];
    title?: string;
    colors?: string[];
    fontFamily?: string;
    textColor?: string;
    backgroundColor?: string;
    gridColor?: string;
    showGrid?: boolean;
    showValues?: boolean;
    animationStyle?: BarAnimationStyle;
    barGap?: number;
}
export declare const BarChart: React.FC<BarChartProps>;
export {};
