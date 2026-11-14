interface StatRevealProps {
    stat: string;
    label?: string;
    accentColor?: string;
    /** Label color. Defaults to near-white; pass the theme's textColor on light themes. */
    textColor?: string;
    position?: "center" | "bottom-right" | "right";
}
export declare const StatReveal: React.FC<StatRevealProps>;
export {};
