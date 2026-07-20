import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    test: {
        include: ["test/live/**/*.test.ts"],
        environment: "node",
        testTimeout: 120000,
        hookTimeout: 120000,
        pool: "forks",
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