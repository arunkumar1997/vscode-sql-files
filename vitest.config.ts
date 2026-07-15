import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/webview/**", "src/extension.ts", "src/**/*.d.ts"],
    },
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/helpers/vscode-mock.ts"),
    },
  },
});
