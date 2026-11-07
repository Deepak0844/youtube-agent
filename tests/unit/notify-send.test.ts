import { describe, expect, it, vi } from "vitest";
import { OSASCRIPT_SOURCE, checkWebhookUrl, osascriptArgs, popupText } from "@/server/core/notify-send";
import { createDesktopPort, createWebhookPort } from "@/server/providers/notify/senders";
import { BlockedAddressError } from "@/server/providers/net/safe-fetch";

describe("popup text", () => {
  it("keeps quotes and backslashes as data, flattens control characters", () => {
    expect(popupText('a "b" \\ c\n\td')).toBe('a "b" \\ c d');
    expect(popupText("x".repeat(500)).length).toBe(200);
  });
  it("never splices studio text into the script", () => {
    const evil = '" & do shell script "touch /tmp/pwn" & "';
    const args = osascriptArgs(evil, evil);
    expect(args[1]).toBe(OSASCRIPT_SOURCE);
    expect(args[1]).not.toContain("pwn");
    expect(args.slice(2)).toEqual([evil, evil]);
  });
});

describe("desktop port", () => {
  it("runs osascript through execFile with an argument list on a Mac", async () => {
    const exec = vi.fn((_f: string, _a: string[], cb: (e: Error | null) => void) => cb(null));
    await createDesktopPort({ platform: "darwin", exec }).send({ title: "T", text: "x", message: "T: x" });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]![0]).toBe("osascript");
  });
  it("does nothing off a Mac, and reports a failing osascript", async () => {
    const exec = vi.fn();
    await createDesktopPort({ platform: "linux", exec }).send({ title: "T", text: "x", message: "m" });
    expect(exec).not.toHaveBeenCalled();
    const bad = createDesktopPort({ platform: "darwin", exec: (_f, _a, cb) => cb(new Error("boom")) });
    await expect(bad.send({ title: "T", text: "x", message: "m" })).rejects.toThrow("boom");
  });
});

describe("webhook address check", () => {
  it.each(["http://127.0.0.1/x", "http://localhost:8080/h", "https://192.168.1.5/h", "http://169.254.169.254/", "http://[::1]/h", "http://2130706433/", "ftp://example.com/x", "https://u:p@example.com/x", "not a url", "http://box.local/h"])("refuses %s", (u) => {
    expect(checkWebhookUrl(u)).not.toBeNull();
  });
  it("accepts a public https address", () => {
    expect(checkWebhookUrl("https://hooks.example.com/services/abc")).toBeNull();
  });
});

describe("webhook port", () => {
  const msg = { title: "T", text: "x", message: "T: x" };
  it("POSTs the JSON body through safeFetch in indirect mode", async () => {
    const sf = vi.fn(async () => new Response("ok", { status: 200 }));
    await createWebhookPort("https://hooks.example.com/a", sf as never).send(msg);
    const [url, init, opts] = sf.mock.calls[0] as unknown as [string, RequestInit, { mode: string }];
    expect(url).toBe("https://hooks.example.com/a");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(msg);
    expect(opts.mode).toBe("indirect");
  });
  it("refuses a private address without sending, and surfaces a blocked resolve and a bad status", async () => {
    const sf = vi.fn();
    await expect(createWebhookPort("http://10.0.0.5/h", sf as never).send(msg)).rejects.toThrow();
    expect(sf).not.toHaveBeenCalled();
    const blocked = vi.fn(async () => { throw new BlockedAddressError("10.0.0.5", "private"); });
    await expect(createWebhookPort("https://sneaky.example.com/h", blocked as never).send(msg)).rejects.toThrow(BlockedAddressError);
    const bad = vi.fn(async () => new Response("no", { status: 500 }));
    await expect(createWebhookPort("https://hooks.example.com/a", bad as never).send(msg)).rejects.toThrow("500");
  });
});
