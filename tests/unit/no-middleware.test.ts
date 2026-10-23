import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Next 16 renamed middleware to proxy.ts; middleware.* is a deprecated convention that
// would run beside (or instead of) the auth redirect in src/proxy.ts.
describe("proxy.ts convention", () => {
  it.each(["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"])(
    "%s does not exist",
    (file) => {
      expect(existsSync(file)).toBe(false);
    },
  );
});
