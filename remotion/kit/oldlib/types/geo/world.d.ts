export type Ring = [number, number][];
export type Country = {
    name: string;
    cont: string;
    rings: Ring[];
    km2: number;
};
export declare const WORLD: Country[];
export declare const byName: (n: string) => Country;
export declare const AFRICA: Country[];
