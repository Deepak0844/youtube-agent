// Pure helpers for connecting a YouTube channel (Google OAuth, authorization code + PKCE). No IO, no network.
import { createHash, randomBytes } from "node:crypto";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";
export const STATE_TTL_MS = 10 * 60_000;

// All scopes are asked for up front so later slices never need a second consent. Deliberately narrow: no broad `youtube` and no
// `youtube.readonly`. Per Google's method docs (verify in the spike): videos.insert accepts upload; thumbnails.set, playlists.*,
// playlistItems.insert, videos.update, channels.list and comments accept youtube.force-ssl; analytics reports accept yt-analytics.readonly.
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
] as const;

const b64url = (b: Buffer) => b.toString("base64url");
export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** 32 random bytes -> 43 url-safe characters: fits both state and the PKCE verifier (43..128). */
export const randomToken = () => b64url(randomBytes(32));
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export function buildAuthUrl(a: { clientId: string; redirectUri: string; state: string; verifier: string }): string {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    state: a.state,
    code_challenge: pkceChallenge(a.verifier),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return u.toString();
}

/** Scopes the owner left unticked on the consent screen. */
// Google reports the email scope by its long name; treat both spellings as the same permission.
const SCOPE_ALIASES: Record<string, string> = { "https://www.googleapis.com/auth/userinfo.email": "email" };
export const missingScopes = (granted: string): string[] => {
  const have = new Set(granted.split(/\s+/).map((s) => SCOPE_ALIASES[s] ?? s));
  return GOOGLE_SCOPES.filter((s) => !have.has(s));
};
/** Short permission name for messages, e.g. "youtube.upload". Names only, never tokens. */
export const scopeLabel = (s: string) => s.slice(s.lastIndexOf("/") + 1);

export interface ChannelInfo {
  channelId: string;
  title: string;
}
export function parseChannels(json: unknown): ChannelInfo[] {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: ChannelInfo[] = [];
  for (const it of items as Array<{ id?: unknown; snippet?: { title?: unknown } }>) {
    if (typeof it?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(it.id)) {
      out.push({ channelId: it.id, title: typeof it.snippet?.title === "string" ? it.snippet.title.slice(0, 200) : "" });
    }
  }
  return out;
}

export const channelSecretName = (rowId: string) => `youtube.channel.${rowId}.refresh`;

// ---- Quota guard (pure part) ----
// Costs per call in YouTube Data API units. VERIFY against Google's quota calculator before relying on them
// (evidence conflicts on videos.insert: older docs say 1600, newer say lower). Unknown calls are refused, never free.
export const QUOTA_COSTS = {
  "channels.list": 1,
  "videos.list": 1,
  "videos.insert": 1600, // verify
  "thumbnails.set": 50, // verify
  "videos.update": 50, // verify
  "playlistItems.insert": 50, // verify
  "commentThreads.list": 1,
  "comments.insert": 50, // verify
} as const;
export type QuotaCall = keyof typeof QUOTA_COSTS;

/** Google resets quota at midnight Pacific time, so the counter's day is the Pacific calendar date, not UTC. */
export const quotaDay = (now: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

export const quotaCost = (call: QuotaCall): number => QUOTA_COSTS[call];
