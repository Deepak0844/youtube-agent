// Time for a scene: everything that moves is a pure function of t (seconds). Never keep state between frames.
import React, { useContext } from "react";

export const TimeContext = React.createContext<number>(0);
/** Seconds since the start of the video (frame / fps). Read it once in your scene and pass it to every `update(t)`. */
export const useT = (): number => useContext(TimeContext);
