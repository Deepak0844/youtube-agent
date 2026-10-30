import { describe, expect, it } from "vitest";
import { checkVoiceField, hostPortOf, isVoiceField } from "@/server/providers/voice/endpoints";

const okv = (f: Parameters<typeof checkVoiceField>[0], v: string, key = false) => {
  const r = checkVoiceField(f, v, key);
  expect(r, v).toMatchObject({ ok: true });
  return r.ok ? r.value : "";
};
const bad = (f: Parameters<typeof checkVoiceField>[0], v: string, key = false) => {
  const r = checkVoiceField(f, v, key);
  expect(r.ok, `${v} should be refused`).toBe(false);
  return r.ok ? "" : r.error;
};

describe("VoiceStudio address (same rule as the voice stage)", () => {
  it("accepts this computer without a key, and an https address with a key", () => {
    expect(okv("voicestudio_url", " http://127.0.0.1:3900 ")).toBe("http://127.0.0.1:3900");
    expect(okv("voicestudio_url", "http://localhost:3900")).toBe("http://localhost:3900");
    expect(okv("voicestudio_url", "http://[::1]:3900")).toBe("http://[::1]:3900");
    expect(okv("voicestudio_url", "https://voice.example.com", true)).toBe("https://voice.example.com");
    expect(okv("voicestudio_url", "")).toBe("");
  });
  it.each(["127.0.0.1:3900", "ftp://127.0.0.1", "http://user:pw@127.0.0.1:3900", "http://", "not a url", "http://192.168.1.5:3900"])("refuses %s", (v) => {
    bad("voicestudio_url", v);
  });
  it("refuses plain http to another computer even with a key", () => {
    bad("voicestudio_url", "http://192.168.1.5:3900", true);
  });
  it("quotes the typed text only as a short clip", () => {
    const e = bad("voicestudio_url", "x".repeat(200));
    expect(e.length).toBeLessThan(200);
  });
});

describe("local voice address", () => {
  it("accepts http(s) without credentials", () => {
    expect(okv("local_url", "http://127.0.0.1:8880")).toBe("http://127.0.0.1:8880");
    expect(okv("local_url", "https://tts.lan:8443")).toBe("https://tts.lan:8443");
  });
  it.each(["file:///etc/passwd", "javascript:alert(1)", "http://a:b@127.0.0.1", "nope"])("refuses %s", (v) => {
    bad("local_url", v);
  });
  it("refuses a key over plain http to another computer", () => {
    bad("local_url", "http://192.168.1.9:8880", true);
    okv("local_url", "http://127.0.0.1:8880", true);
  });
});

describe("Azure region", () => {
  it("accepts the stage's own shape", () => {
    expect(okv("azure_region", "westeurope")).toBe("westeurope");
    expect(okv("azure_region", "")).toBe("");
  });
  it.each(["EU", "ab", "west europe", "west_europe", "a".repeat(31), "https://x.test"])("refuses %s", (v) => {
    bad("azure_region", v);
  });
});

describe("helpers", () => {
  it("hostPortOf gives the list spelling, with default ports", () => {
    expect(hostPortOf("http://127.0.0.1:3900")).toBe("127.0.0.1:3900");
    expect(hostPortOf("http://LOCALHOST")).toBe("localhost:80");
    expect(hostPortOf("https://x.test")).toBe("x.test:443");
    expect(hostPortOf("http://[::1]:3900")).toBe("[::1]:3900");
    expect(hostPortOf("ftp://x")).toBeNull();
    expect(hostPortOf("junk")).toBeNull();
  });
  it("only the three voice fields are known", () => {
    expect(isVoiceField("azure_region")).toBe(true);
    expect(isVoiceField("network.local_services")).toBe(false);
    expect(isVoiceField("__proto__")).toBe(false);
  });
});
