import { describe, expect, it } from "vitest";
import { renderBodyTemplate, TemplateError } from "@/server/core/voice-template";

const vars = { text: "hello", voice: "v1", lang: "en" };
const T = '{"input":"{text}","opts":{"voice":"{voice}","langs":["{lang}"],"n":1}}';

describe("renderBodyTemplate", () => {
  it("fills whole-value placeholders", () => {
    expect(JSON.parse(renderBodyTemplate(T, vars))).toEqual({ input: "hello", opts: { voice: "v1", langs: ["en"], n: 1 } });
  });
  it("template_injection_text_with_quotes_and_braces_stays_one_string", () => {
    for (const text of ['"}, "x": "1', "{voice}", '\\", "a":{', "a\u0000b\ud800", "\n}{"]) {
      const out = JSON.parse(renderBodyTemplate(T, { ...vars, text })) as { input: string; x?: unknown; opts: object };
      expect(Object.keys(out)).toEqual(["input", "opts"]);
      expect(out.input).toBe(JSON.parse(JSON.stringify(text)));
    }
  });
  it("placeholder_in_key_or_unknown_placeholder_throws", () => {
    for (const t of ['{"{text}":"x"}', '{"a":"{other}"}', '{"a":"say {text}"}', '{"a":"{text"}', '{"a":"{{text}}"}', '{"a":"text}"}', "not json", '"{text}"', '{"a":["{x}"]}'])
      expect(() => renderBodyTemplate(t, vars), t).toThrow(TemplateError);
  });
  it("leaves other values alone", () => {
    expect(JSON.parse(renderBodyTemplate('{"a":null,"b":true,"c":"plain"}', vars))).toEqual({ a: null, b: true, c: "plain" });
  });
});
