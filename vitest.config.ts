import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Wrangler auto-bundles `*.html` imports as strings at runtime. Vite/Vitest
// don't — so for tests we stub any `.html` import with its raw contents.
const htmlAsString = {
  name: "html-as-string",
  enforce: "pre" as const,
  load(id: string) {
    if (id.endsWith(".html")) {
      const text = readFileSync(id, "utf8");
      return `export default ${JSON.stringify(text)};`;
    }
    return null;
  },
};

export default defineConfig({
  plugins: [htmlAsString],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
