export type ParticleType = "fireflies" | "petals" | "sparkles" | "mist" | "light-rays";
interface ParticleOverlayProps {
    type: ParticleType;
    count?: number;
    color?: string;
    intensity?: number;
}
export declare const ParticleOverlay: React.FC<ParticleOverlayProps>;
export {};
