import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The compose contract (docs/adr/0016): who gets the Docker socket, what is published, who waits for whom.
type Svc = { networks?: string[]; read_only?: boolean; healthcheck?: { test: string[] }; build?: { dockerfile: string }; ports?: string[]; volumes?: string[]; user?: string; group_add?: string[]; environment?: Record<string, string>; depends_on?: Record<string, { condition: string }>; command?: string; container_name?: string; cap_drop?: string[]; extra_hosts?: string[] };
const doc = parse(readFileSync("docker-compose.yml", "utf8"), { merge: true }) as { services: Record<string, Svc>; volumes: Record<string, unknown>; networks?: Record<string, { internal?: boolean }> };
const s = doc.services;
const SOCK = "/var/run/docker.sock:/var/run/docker.sock";

describe("docker-compose.yml", () => {
  it("has exactly the studio's services (no egress proxy: nothing calls it)", () => {
    expect(Object.keys(s).sort()).toEqual(["init", "postgres", "redis", "render-runner", "searxng", "web", "worker"]);
  });
  it("only the render service has the docker socket: the worker, web, init and the rest never do", () => {
    expect(s["render-runner"]!.volumes).toContain(SOCK);
    for (const name of ["worker", "web", "init", "postgres", "redis", "searxng"]) expect(s[name]!.volumes ?? [], name).not.toContain(SOCK);
  });
  it("the render service joins the socket's group; nobody else does", () => {
    expect(s["render-runner"]!.group_add).toEqual(["${DOCKER_GID}"]);
    for (const name of ["worker", "web", "init"]) expect(s[name]!.group_add, name).toBeUndefined();
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
    // the worker no longer needs the host-side path: the render service does the translation
    expect(s.worker!.environment!.HOST_STORAGE_ROOT).toBeUndefined();
    expect(s.web!.environment!.HOST_STORAGE_ROOT).toBeUndefined();
  });
  it("web and worker wait for init; init waits for a healthy postgres", () => {
    for (const name of ["web", "worker"]) expect(s[name]!.depends_on!.init!.condition, name).toBe("service_completed_successfully");
    expect(s.init!.depends_on!.postgres!.condition).toBe("service_healthy");
  });
  it("init also gets the data folder: the sound library import writes <storage>/audio there for the worker to read", () => {
    expect(s.init!.volumes).toContain("${HOST_STORAGE_ROOT}:/data");
  });
  it("the app image says it runs in its own container (host.docker.internal is pinned by its hosts file)", () => {
    expect(readFileSync("infra/Dockerfile.app", "utf8")).toMatch(/^ENV [^\n]*YTSTUDIO_IN_CONTAINER=1/m);
  });
  it("the published web port is an own-service port, so it can never be listed as a local service", () => {
    for (const name of ["web", "worker"]) expect(s[name]!.environment!.OWN_SERVICE_PORTS, name).toBe("${WEB_PORT:-3000}");
  });
  it("the app image removes group-root write access (the worker joins group root on OrbStack for the socket) and fails the build if any remains", () => {
    const df = readFileSync("infra/Dockerfile.app", "utf8");
    expect(df).toContain("-group 0 -perm -g+w ! -perm -o+w -exec chmod g-w {} +");
    expect(df).toMatch(/test -z "\$\(find \/ -xdev[^\n]*-group 0 -perm -g\+w/);
  });
  it("the app image has no Docker CLI: the worker never touches Docker, the render service does", () => {
    expect(readFileSync("infra/Dockerfile.app", "utf8")).not.toMatch(/docker:27-cli|\/usr\/local\/bin\/docker/);
  });
  it("web is told tool checks come from the worker", () => {
    expect(s.web!.environment!.TOOLS_CHECKED_BY).toBe("worker");
    expect(s.worker!.environment!.TOOLS_CHECKED_BY).toBeUndefined();
  });
  it("web and worker get the read-only backup URL (so backups work), never the owner or superuser", () => {
    for (const name of ["web", "worker"]) {
      const e = s[name]!.environment!;
      expect(e.BACKUP_DATABASE_URL, name).toContain("ytstudio_backup");
      expect(JSON.stringify(e), name).not.toMatch(/ytstudio_owner|postgres:\$\{POSTGRES_PASSWORD\}/);
    }
    expect(s.init!.environment!.YTSTUDIO_BACKUP_PASSWORD).toBe("${YTSTUDIO_BACKUP_PASSWORD}");
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

  describe("the render service", () => {
    const rr = () => s["render-runner"]!;
    it("is built from its own Dockerfile and sees the data folder read-only", () => {
      expect(rr().build!.dockerfile).toBe("infra/Dockerfile.render-runner");
      expect(rr().volumes).toContain("${HOST_STORAGE_ROOT}:/data:ro");
    });
    it("holds only what it needs: the image, the host path, the token; no database, vault or Claude login", () => {
      const e = rr().environment!;
      expect(e.RENDER_IMAGE).toBe("${RENDER_IMAGE:-ytstudio-render:dev}");
      expect(e.HOST_STORAGE_ROOT).toBe("${HOST_STORAGE_ROOT}");
      expect(e.RENDER_RUNNER_TOKEN).toBe("${RENDER_RUNNER_TOKEN}");
      expect(JSON.stringify(e)).not.toMatch(/DATABASE|VAULT|REDIS|PASSWORD|ANTHROPIC/i);
      expect((rr().volumes ?? []).join(" ")).not.toMatch(/claude-home|pgdata/);
    });
    it("is locked down: no capabilities, no new privileges, read-only root", () => {
      expect(rr().cap_drop).toEqual(["ALL"]);
      expect((rr() as { security_opt?: string[] }).security_opt).toEqual(["no-new-privileges:true"]);
      expect(rr().read_only).toBe(true);
    });
    it("is on the private render network only, which has no way out; the worker joins it, web and the rest do not", () => {
      expect(rr().networks).toEqual(["render"]);
      expect(doc.networks!.render).toMatchObject({ internal: true });
      expect(s.worker!.networks).toEqual(expect.arrayContaining(["default", "render"]));
      for (const name of ["web", "init", "postgres", "redis", "searxng"]) expect(s[name]!.networks ?? ["default"], name).not.toContain("render");
    });
    it("publishes no port and has a healthcheck that needs Docker to answer", () => {
      expect(rr().ports).toBeUndefined();
      expect(rr().healthcheck!.test.join(" ")).toMatch(/\/v1\/info/);
      expect(rr().healthcheck!.test.join(" ")).toMatch(/ready/);
    });
    it("the worker asks it (url + token) and waits until it is healthy", () => {
      expect(s.worker!.environment!.RENDER_RUNNER_URL).toBe("http://render-runner:4100");
      expect(s.worker!.environment!.RENDER_RUNNER_TOKEN).toBe("${RENDER_RUNNER_TOKEN}");
      expect(s.worker!.depends_on!["render-runner"]!.condition).toBe("service_healthy");
      expect(s.web!.environment!.RENDER_RUNNER_TOKEN).toBeUndefined();
      expect(s.web!.environment!.RENDER_RUNNER_URL).toBeUndefined();
    });
  });
});
