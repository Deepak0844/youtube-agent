interface PieDatum {
    label: string;
    value: number;
    color?: string;
}
type PieAnimationStyle = "spin" | "expand" | "sequential";
interface PieChartProps {
    data: PieDatum[];
    title?: string;
    colors?: string[];
    fontFamily?: string;
    textColor?: string;
    backgroundColor?: string;
    donut?: boolean;
    centerLabel?: string;
    centerValue?: string;
    showLegend?: boolean;
    animationStyle?: PieAnimationStyle;
}
export declare const PieChart: React.FC<PieChartProps>;
export {};
