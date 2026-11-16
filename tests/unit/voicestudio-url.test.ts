import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertVoiceStudioUrl, isLoopbackHost } from "@/server/providers/voice/voicestudio";

// Inside docker compose the machine that runs VoiceStudio is the Docker host, named host.docker.internal. It counts as "this
// computer" (no key needed, plain http fine), but only that exact name: look-alikes are other computers.
describe("host.docker.internal is this computer (inside the app's container only)", () => {
  // Inside the app image the name comes from the container's hosts file (compose extra_hosts), so it is pinned to the Docker host.
  // Anywhere else it would be answered by ordinary DNS, so it must not unlock the no-key rule there.
  beforeEach(() => { process.env.YTSTUDIO_IN_CONTAINER = "1"; });
  afterEach(() => { delete process.env.YTSTUDIO_IN_CONTAINER; });
  it("is accepted without a key, and with a key over plain http (same as loopback)", () => {
    for (const u of ["http://host.docker.internal:3900", "http://HOST.Docker.Internal:3900", "http://host.docker.internal"]) {
      expect(() => assertVoiceStudioUrl(u, false), u).not.toThrow();
      expect(() => assertVoiceStudioUrl(u, true), u).not.toThrow();
    }
    expect(isLoopbackHost("host.docker.internal")).toBe(true);
  });
  it("look-alike names are other computers: no key is refused, a key over http is refused", () => {
    for (const u of ["http://host.docker.internal.evil.com:3900", "http://evilhost.docker.internal:3900", "http://docker.internal:3900", "http://host.docker.internal@evil.com:3900"]) {
      expect(() => assertVoiceStudioUrl(u, false), u).toThrow();
      expect(() => assertVoiceStudioUrl(u, true), u).toThrow();
    }
    expect(isLoopbackHost("host.docker.internal.evil.com")).toBe(false);
    expect(isLoopbackHost("xhost.docker.internal")).toBe(false);
  });
  it("the old rules still hold: loopback ok, another computer needs a key and https", () => {
    expect(() => assertVoiceStudioUrl("http://127.0.0.1:3900", false)).not.toThrow();
    expect(() => assertVoiceStudioUrl("http://192.168.1.5:3900", false)).toThrow(/key/i);
    expect(() => assertVoiceStudioUrl("http://192.168.1.5:3900", true)).toThrow(/https/);
  });
  it("outside the app's container the name is just another computer: no key is refused", () => {
    delete process.env.YTSTUDIO_IN_CONTAINER;
    expect(isLoopbackHost("host.docker.internal")).toBe(false);
    expect(() => assertVoiceStudioUrl("http://host.docker.internal:3900", false)).toThrow(/key/i);
    expect(() => assertVoiceStudioUrl("http://host.docker.internal:3900", true)).toThrow(/https/);
    expect(isLoopbackHost("localhost")).toBe(true); // loopback is unaffected
  });
});
