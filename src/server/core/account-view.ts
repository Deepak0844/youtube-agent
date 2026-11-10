import { MIN_PASSWORD_LENGTH, validatePassword } from "./auth-rules";

// Words for the Account page (Phase 9 parity): what to tell the owner when a password change is refused, and how to show a session. Pure: no IO.
// Fixed sentences only. Nothing echoes the typed passwords, and a refusal never says which part was wrong beyond what the owner typed themselves.

export const MAX_PASSWORD_INPUT = 1024;

/** A problem the owner can fix before anything is sent, or null. `username` is the owner's, to refuse a password equal to it. */
export function passwordFormProblem(current: string, next: string, again: string, username: string): string | null {
  if (current === "") return "Enter your current password.";
  if (next === "") return "Enter a new password.";
  if (next.length > MAX_PASSWORD_INPUT || current.length > MAX_PASSWORD_INPUT || again.length > MAX_PASSWORD_INPUT) return "That password is too long.";
  if (next !== again) return "The two new passwords are not the same.";
  if (next === current) return "The new password is the same as the current one. Pick a different one.";
  const v = validatePassword(next, username);
  if (!v.ok) {
    return v.reason === "too_short" ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : v.reason === "common" ? "That password is too common. Pick something longer and less guessable." : "The password cannot be the same as your username.";
  }
  return null;
}

/** What to say when the server refuses the change. */
export function changePasswordMessage(reason: "invalid" | "weak_password" | "locked" | "busy"): string {
  switch (reason) {
    case "invalid":
      return "The current password is not right. Nothing was changed.";
    case "locked":
      return "Too many wrong tries. Wait a few minutes and try again.";
    case "busy":
      return "Busy right now. Try again in a moment.";
    case "weak_password":
      return "That password cannot be used. Pick a longer, less guessable one.";
  }
}

/** A short, safe label for a browser: the first recognisable product name, else "Unknown browser". Never the whole user-agent text. */
export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl\//i.test(ua) ? "curl" : null;
  const os = /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  if (!browser && !os) return "Unknown browser";
  return [browser ?? "Browser", os ? `on ${os}` : null].filter(Boolean).join(" ");
}
