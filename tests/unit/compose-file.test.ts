import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The compose contract (docs/adr/0016): who gets the Docker socket, what is published, who waits for whom.
type Svc = { ports?: string[]; volumes?: string[]; user?: string; group_add?: string[]; environment?: Record<string, string>; depends_on?: Record<string, { condition: string }>; command?: string; container_name?: string; cap_drop?: string[]; extra_hosts?: string[] };
const doc = parse(readFileSync("docker-compose.yml", "utf8"), { merge: true }) as { services: Record<string, Svc>; volumes: Record<string, unknown> };
const s = doc.services;
const SOCK = "/var/run/docker.sock:/var/run/docker.sock";

describe("docker-compose.yml", () => {
  it("has exactly the studio's services (no egress proxy: nothing calls it)", () => {
    expect(Object.keys(s).sort()).toEqual(["init", "postgres", "redis", "searxng", "web", "worker"]);
  });
  it("only the worker has the docker socket; web and init never do", () => {
    expect(s.worker!.volumes).toContain(SOCK);
    for (const name of ["web", "init", "postgres", "redis", "searxng"]) expect(s[name]!.volumes ?? [], name).not.toContain(SOCK);
  });
  it("the worker joins the socket's group so the non-root app user can use it", () => {
    expect(s.worker!.group_add).toEqual(["${DOCKER_GID}"]);
    expect(s.web!.group_add).toBeUndefined();
  });
  it("web publishes only loopback port 3000; nothing else publishes a port", () => {
    expect(s.web!.ports).toEqual(["127.0.0.1:${WEB_PORT:-3000}:3000"]);
    for (const [name, svc] of Object.entries(s)) if (name !== "web") expect(svc.ports, name).toBeUndefined();
  });
  it("web and worker share the claude-home volume as HOME and run as the app user from the env", () => {
    for (const name of ["web", "worker"]) {
      expect(s[name]!.volumes, name).toContain("claude-home:/home/app");
      expect(s[name]!.user, name).toBe("${APP_UID}:${APP_GID}");
    }
    expect(Object.keys(doc.volumes)).toEqual(expect.arrayContaining(["pgdata", "claude-home"]));
  });
  it("web and worker share the data folder; the worker is told its host-side path", () => {
    for (const name of ["web", "worker"]) expect(s[name]!.volumes, name).toContain("${HOST_STORAGE_ROOT}:/data");
    expect(s.worker!.environment!.HOST_STORAGE_ROOT).toBe("${HOST_STORAGE_ROOT}");
    expect(s.web!.environment!.HOST_STORAGE_ROOT).toBeUndefined();
  });
  it("web and worker wait for init; init waits for a healthy postgres", () => {
    for (const name of ["web", "worker"]) expect(s[name]!.depends_on!.init!.condition, name).toBe("service_completed_successfully");
    expect(s.init!.depends_on!.postgres!.condition).toBe("service_healthy");
  });
  it("web is told tool checks come from the worker", () => {
    expect(s.web!.environment!.TOOLS_CHECKED_BY).toBe("worker");
    expect(s.worker!.environment!.TOOLS_CHECKED_BY).toBeUndefined();
  });
  it("only init gets the superuser and owner database URLs; web and worker get the app role only", () => {
    expect(Object.keys(s.init!.environment!)).toEqual(expect.arrayContaining(["BOOTSTRAP_DATABASE_URL", "MIGRATE_DATABASE_URL"]));
    for (const name of ["web", "worker"]) {
      const e = s[name]!.environment!;
      expect(e.BOOTSTRAP_DATABASE_URL, name).toBeUndefined();
      expect(e.MIGRATE_DATABASE_URL, name).toBeUndefined();
      expect(e.DATABASE_URL, name).toContain("ytstudio_app");
    }
  });
  it("the app containers drop every capability and cannot gain new ones", () => {
    for (const name of ["web", "worker", "init"]) expect(s[name]!.cap_drop, name).toEqual(["ALL"]);
  });
  it("worker and web can reach a service on the host machine (VoiceStudio, Ollama) as host.docker.internal", () => {
    for (const name of ["web", "worker"]) expect(s[name]!.extra_hosts, name).toContain("host.docker.internal:host-gateway");
  });
});
