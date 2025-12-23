import path from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflareDevProxy } from "@react-router/dev/vite/cloudflare";
import { defineConfig } from "vite";

export default defineConfig(({ isSsrBuild }) => ({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./app"),
    },
  },
  build: {
    rollupOptions: isSsrBuild ? { input: "./workers/app.ts" } : undefined,
  },
  plugins: [cloudflareDevProxy(), reactRouter()],
}));
