// Shapes shared by the server actions and the client form. Plain data only: the submitted secret is never part of any state.
export interface SaveState {
  status: "idle" | "saved" | "error";
  message?: string;
  fieldErrors?: { clientId?: string; clientSecret?: string; form?: string };
}
export interface TestState {
  status: "idle" | "done";
  result?: { clientId: boolean; secret: boolean; redirectUri: boolean };
}
export const IDLE_SAVE: SaveState = { status: "idle" };
export const IDLE_TEST: TestState = { status: "idle" };
