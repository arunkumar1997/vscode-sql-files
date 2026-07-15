import * as assert from "assert";
import * as vscode from "vscode";

suite("Activation", () => {
  test("extension activates successfully", async () => {
    const ext = vscode.extensions.getExtension("arunkumar1997.file-sql");
    assert.ok(ext, "Extension not found");
    await ext.activate();
    assert.strictEqual(ext.isActive, true, "Extension should be active");
  });

  test("all commands are registered", async () => {
    const ext = vscode.extensions.getExtension("arunkumar1997.file-sql");
    assert.ok(ext);
    await ext.activate();

    const allCommands = await vscode.commands.getCommands(true);

    const expectedCommands = [
      "fileSql.addPath",
      "fileSql.addFolder",
      "fileSql.openQueryEditor",
      "fileSql.clearTables",
      "fileSql.removeTable",
      "fileSql.renameTable",
      "fileSql.copyTableName",
      "fileSql.copyColumnName",
      "fileSql.openFileInSql",
    ];

    for (const cmd of expectedCommands) {
      assert.ok(
        allCommands.includes(cmd),
        `Expected command "${cmd}" to be registered`,
      );
    }
  });
});
