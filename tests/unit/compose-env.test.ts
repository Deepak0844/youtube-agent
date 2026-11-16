import { describe, expect, it } from "vitest";
import { COMPOSE_ENV_KEYS, renderComposeEnv } from "@/server/core/compose-env";

let n = 0;
const make = () => renderComposeEnv({ hostStorageRoot: "/srv/studio/data", uid: 1000, gid: 1000, dockerGid: 999, password: () => `pw${++n}`.padEnd(32, "x"), masterKey: () => "KEY=".padEnd(44, "k") });
const parse = (text: string) => Object.fromEntries(text.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("renderComposeEnv", () => {
  it("renders every key exactly once, with fresh passwords and an absolute storage root", () => {
    const text = make();
    const lines = text.trim().split("\n");
    expect(lines.map((l) => l.split("=")[0])).toEqual([...COMPOSE_ENV_KEYS]);
    const env = parse(text);
    expect(env.HOST_STORAGE_ROOT).toBe("/srv/studio/data");
    expect(env.APP_UID).toBe("1000");
    expect(env.APP_GID).toBe("1000");
    expect(env.DOCKER_GID).toBe("999");
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.RENDER_IMAGE).toBe("ytstudio-render:dev");
    expect(new Set([env.POSTGRES_PASSWORD, env.YTSTUDIO_OWNER_PASSWORD, env.YTSTUDIO_APP_PASSWORD]).size).toBe(3);
    expect(env.VAULT_MASTER_KEY).toHaveLength(44);
  });
  it("refuses a relative storage root", () => {
    expect(() => renderComposeEnv({ hostStorageRoot: "data", uid: 1, gid: 1, dockerGid: 0, password: () => "x".repeat(32), masterKey: () => "k" })).toThrow("absolute");
  });
});
