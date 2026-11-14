type CalloutType = "info" | "warning" | "tip" | "quote";
interface CalloutBoxProps {
    text: string;
    type?: CalloutType;
    icon?: string;
    title?: string;
    borderColor?: string;
    backgroundColor?: string;
    textColor?: string;
    fontFamily?: string;
    fontSize?: number;
    titleFontSize?: number;
    containerBackgroundColor?: string;
}
export declare const CalloutBox: React.FC<CalloutBoxProps>;
export {};
