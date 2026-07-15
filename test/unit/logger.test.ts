import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import * as logger from "../../src/logger";

describe("logger", () => {
  // channel must be re-acquired each time because initLogger replaces it
  let channel: ReturnType<typeof logger.getLogger>;

  beforeEach(() => {
    channel = logger.getLogger();
    vi.mocked(channel.appendLine).mockClear();
    vi.mocked(channel.show).mockClear();
  });

  describe("initLogger / getLogger", () => {
    it("creates an output channel named 'File SQL' with log flag", () => {
      expect(vscode.window.createOutputChannel).toHaveBeenCalledWith("File SQL", { log: true });
    });

    it("getLogger returns the same channel on subsequent calls", () => {
      const ch1 = logger.getLogger();
      const ch2 = logger.getLogger();
      expect(ch1).toBe(ch2);
    });

    it("initLogger returns an output channel", () => {
      const ch = logger.initLogger();
      expect(ch).toBeDefined();
      expect(ch.appendLine).toBeDefined();
    });
  });

  describe("log", () => {
    it("appends a timestamped message to the output channel", () => {
      const dateSpy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2025-01-01T00:00:00.000Z");
      logger.log("test message");
      expect(channel.appendLine).toHaveBeenCalledWith("[2025-01-01T00:00:00.000Z] test message");
      dateSpy.mockRestore();
    });
  });

  describe("logInfo", () => {
    it("prepends INFO prefix", () => {
      const dateSpy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2025-01-01T00:00:00.000Z");
      logger.logInfo("startup complete");
      expect(channel.appendLine).toHaveBeenCalledWith("[2025-01-01T00:00:00.000Z] INFO: startup complete");
      dateSpy.mockRestore();
    });
  });

  describe("logWarn", () => {
    it("prepends WARN prefix", () => {
      const dateSpy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2025-01-01T00:00:00.000Z");
      logger.logWarn("disk nearly full");
      expect(channel.appendLine).toHaveBeenCalledWith("[2025-01-01T00:00:00.000Z] WARN: disk nearly full");
      dateSpy.mockRestore();
    });
  });

  describe("logDebug", () => {
    it("prepends DEBUG prefix", () => {
      const dateSpy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2025-01-01T00:00:00.000Z");
      logger.logDebug("variable x = 42");
      expect(channel.appendLine).toHaveBeenCalledWith("[2025-01-01T00:00:00.000Z] DEBUG: variable x = 42");
      dateSpy.mockRestore();
    });
  });

  describe("logError", () => {
    it("formats error with message and Error object", () => {
      const dateSpy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2025-01-01T00:00:00.000Z");
      logger.logError("connection failed", new Error("ECONNREFUSED"));
      expect(channel.appendLine).toHaveBeenCalledWith(
        "[2025-01-01T00:00:00.000Z] ERROR: connection failed — ECONNREFUSED",
      );
      dateSpy.mockRestore();
    });

    it("formats error with a string error argument", () => {
      const dateSpy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2025-01-01T00:00:00.000Z");
      logger.logError("oops", "string error");
      expect(channel.appendLine).toHaveBeenCalledWith(
        "[2025-01-01T00:00:00.000Z] ERROR: oops — string error",
      );
      dateSpy.mockRestore();
    });

    it("formats error without error argument", () => {
      const dateSpy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2025-01-01T00:00:00.000Z");
      logger.logError("generic failure");
      expect(channel.appendLine).toHaveBeenCalledWith(
        "[2025-01-01T00:00:00.000Z] ERROR: generic failure — undefined",
      );
      dateSpy.mockRestore();
    });
  });

  describe("showOutput", () => {
    it("calls show() on the output channel", () => {
      logger.showOutput();
      expect(channel.show).toHaveBeenCalled();
    });
  });
});
