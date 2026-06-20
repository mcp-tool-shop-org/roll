import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      // Reporting only this wave — coverage is still being built up, so no
      // hard failing threshold yet (a low floor avoids blocking the swarm).
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
