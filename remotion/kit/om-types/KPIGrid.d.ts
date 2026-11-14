interface Metric {
    label: string;
    value: number;
    prefix?: string;
    suffix?: string;
    change?: number;
    icon?: string;
}
type KPIAnimationStyle = "count-up" | "pop" | "cascade";
interface KPIGridProps {
    metrics: Metric[];
    title?: string;
    columns?: 2 | 3 | 4;
    colors?: string[];
    fontFamily?: string;
    textColor?: string;
    backgroundColor?: string;
    cardBackgroundColor?: string;
    positiveColor?: string;
    negativeColor?: string;
    animationStyle?: KPIAnimationStyle;
}
export declare const KPIGrid: React.FC<KPIGridProps>;
export {};
