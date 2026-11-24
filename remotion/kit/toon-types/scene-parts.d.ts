export declare const SceneContext: import("react").Context<string | null>;
export declare const useSceneId: () => string;
/** The pieces of one scene, found in the page when needed (the scene's React nodes attach after their children ran). */
export declare function sceneParts(id: string): {
    id: string;
    div: HTMLElement;
    svg: SVGSVGElement & {
        defs?: Element;
    };
    defs: Element;
    cam: SVGGElement;
};
