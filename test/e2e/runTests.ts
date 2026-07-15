import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // When compiled, this file is at out-e2e/test/e2e/runTests.js
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        "--disable-extensions",
        "--disable-workspace-trust",
      ],
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

main();
