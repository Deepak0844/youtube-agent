interface SectionTitleProps {
    title: string;
    subtitle?: string;
    accentColor?: string;
    /** Title color. Defaults to near-white; pass the theme's textColor on light themes. */
    textColor?: string;
    position?: "top-left" | "bottom-left" | "center";
}
export declare const SectionTitle: React.FC<SectionTitleProps>;
export {};
