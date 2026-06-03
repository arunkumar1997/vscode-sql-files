import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel;

export function initLogger(): vscode.OutputChannel {
  outputChannel = vscode.window.createOutputChannel("File SQL", { log: true });
  return outputChannel;
}

export function getLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("File SQL", {
      log: true,
    });
  }
  return outputChannel;
}

export function log(message: string): void {
  getLogger().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(message: string, error?: unknown): void {
  const errorMsg = error instanceof Error ? error.message : String(error);
  getLogger().appendLine(
    `[${new Date().toISOString()}] ERROR: ${message}${errorMsg ? ` — ${errorMsg}` : ""}`,
  );
}

export function logInfo(message: string): void {
  log(`INFO: ${message}`);
}

export function logWarn(message: string): void {
  log(`WARN: ${message}`);
}

export function logDebug(message: string): void {
  log(`DEBUG: ${message}`);
}

export function showOutput(): void {
  getLogger().show();
}
