import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/webview/**", "src/extension.ts", "src/**/*.d.ts"],
      reportsDirectory: "coverage-integration",
    },
  },
  forks: {
    singleFork: true,
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/helpers/vscode-mock.ts"),
    },
  },
});
