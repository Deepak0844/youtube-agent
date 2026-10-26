import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

/** Focus ring (Doc 3 §7): 2 px --text, offset 2 px. Keyboard only. */
export const focusRing =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";

/** Colour-only transition, switched off under reduced motion (Doc 3 §8). */
export const fade = "transition-colors duration-150 motion-reduce:transition-none";

/** 36 px on desktop, 44 px touch target on phone (Doc 3 §9). */
export const control = "min-h-11 sm:min-h-9";
