import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react() as any],
  test: {
    environment: "jsdom",
    include: [
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
    ],
    setupFiles: ["./test/setup.ts"],
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./app"),
    },
  },
});
