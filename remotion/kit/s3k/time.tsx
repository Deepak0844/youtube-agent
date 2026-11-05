// Time for a scene: everything that moves is a pure function of t (seconds). Never keep state between frames.
import React, { useContext } from "react";

export const TimeContext = React.createContext<number>(0);
/** Seconds since the start of the video (frame / fps). Read it once in your scene and pass it to every `update(t)`. */
export const useT = (): number => useContext(TimeContext);

/** Returns the same object while its contents (as JSON) are unchanged, so inline props like `focus={{...}}` do not rebuild the scene every frame. */
export function useStable<T>(value: T): T {
  const ref = React.useRef(value);
  const key = JSON.stringify(value);
  const keyRef = React.useRef(key);
  if (keyRef.current !== key) { keyRef.current = key; ref.current = value; }
  return ref.current;
}
