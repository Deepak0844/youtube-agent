interface DataPoint {
    x: number;
    y: number;
}
interface Series {
    label: string;
    data: DataPoint[];
    color?: string;
}
type LineAnimationStyle = "draw" | "fade-in";
interface LineChartProps {
    series: Series[];
    title?: string;
    colors?: string[];
    fontFamily?: string;
    textColor?: string;
    backgroundColor?: string;
    gridColor?: string;
    showGrid?: boolean;
    showMarkers?: boolean;
    showLegend?: boolean;
    xLabel?: string;
    yLabel?: string;
    animationStyle?: LineAnimationStyle;
    strokeWidth?: number;
}
export declare const LineChart: React.FC<LineChartProps>;
export {};
