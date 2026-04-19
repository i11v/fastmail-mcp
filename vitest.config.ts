import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

// Mirrors wrangler's Text rule for `.md` so skill files import identically
// under test and under production bundling.
const mdAsText = {
  name: "md-as-text",
  transform(_code: string, id: string) {
    const path = id.split("?")[0];
    if (path.endsWith(".md")) {
      const src = readFileSync(path, "utf-8");
      return { code: `export default ${JSON.stringify(src)};`, map: null };
    }
    return null;
  },
};

export default defineConfig({
  plugins: [mdAsText],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
