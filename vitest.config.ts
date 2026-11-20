import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  test: {
    environment: "node",
    // Default is cores - 1 (15 on the dev machine): two parallel runs
    // exhausted WSL's memory and froze every session. Keep this low.
    maxWorkers: 4,
  }
});
