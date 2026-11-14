type HeroTitleProps = {
    title: string;
    subtitle?: string;
    /** Color of the leading accent characters and the underline. */
    accentColor?: string;
    /** Color of the remaining title characters. Pass the theme's textColor. */
    textColor?: string;
    /** Subtitle color. */
    subtitleColor?: string;
    /**
     * Scrim painted behind the title so it separates from whatever is underneath.
     * Defaults to a dark wash; a light theme must pass a light one, otherwise the
     * scrim darkens the backdrop and cancels out the theme's dark text.
     */
    scrimBackground?: string;
};
export declare const HeroTitle: React.FC<HeroTitleProps>;
export {};
