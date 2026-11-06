// Plain data shared by the server action and the client form. `secret` exists only in the one response that creates a token.
export type CreateState = { status: "idle" } | { status: "error"; message: string } | { status: "created"; secret: string; name: string };
export const IDLE_CREATE: CreateState = { status: "idle" };
