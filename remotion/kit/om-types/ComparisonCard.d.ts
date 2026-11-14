type ChangeDirection = "up" | "down" | "neutral";
interface ComparisonCardProps {
    leftLabel: string;
    rightLabel: string;
    leftValue: string;
    rightValue: string;
    leftColor?: string;
    rightColor?: string;
    title?: string;
    changeIndicator?: string;
    changeDirection?: ChangeDirection;
    backgroundColor?: string;
    cardBackgroundColor?: string;
    textColor?: string;
    fontFamily?: string;
    titleFontSize?: number;
    labelFontSize?: number;
    valueFontSize?: number;
}
export declare const ComparisonCard: React.FC<ComparisonCardProps>;
export {};
