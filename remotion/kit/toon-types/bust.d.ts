import React from "react";
import type { ToonRuntime } from "./runtime";
export type BustProps = {
    who?: string;
    look?: Record<string, string | number | boolean | null>;
    act: (t: number) => {
        x: number;
        y: number;
        s: number;
        ex?: object;
    };
};
export declare function makeBust(pick: (rt: ToonRuntime, opts: Record<string, any>) => any, after?: (bust: any, opts: Record<string, any>) => void): React.FC<BustProps>;
