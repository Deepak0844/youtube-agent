import React from "react";

/** World position of the element a block is drawn in (the Engine provides it around each placed element). */
export const OriginContext = React.createContext<[number, number, number]>([0, 0, 0]);
export const useOrigin = (): [number, number, number] => React.useContext(OriginContext);
