import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockShowQuickPick, mockGetConfiguration } = vi.hoisted(() => ({
    mockShowQuickPick: vi.fn(),
    mockGetConfiguration: vi.fn(),
}));

vi.mock("vscode", () => ({
    window: {
        showQuickPick: mockShowQuickPick,
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        withProgress: vi.fn(),
        createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
    },
    workspace: {
        getConfiguration: mockGetConfiguration,
    },
    ProgressLocation: { Notification: 15 },
    EventEmitter: class { event = vi.fn(); fire = vi.fn(); dispose = vi.fn(); },
    Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }) },
}));

import { resolveS3ReadMode } from "../../src/s3RangeRead";

describe("resolveS3ReadMode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default config mock
        mockGetConfiguration.mockReturnValue({
            get: (key: string, def: unknown) => {
                if (key === "s3ReadMode") return "ask";
                if (key === "awsProfile") return "default";
                if (key === "awsRegion") return "us-east-1";
                if (key === "maxResultRows") return 1000;
                return def;
            },
        });
    });

    describe("non-eligible files (non-parquet)", () => {
        it("returns 'download' for CSV files regardless of setting", async () => {
            const result = await resolveS3ReadMode(["data/file.csv"]);
            expect(result).toBe("download");
            expect(mockShowQuickPick).not.toHaveBeenCalled();
        });

        it("returns 'download' for JSON files", async () => {
            const result = await resolveS3ReadMode(["data/file.json"]);
            expect(result).toBe("download");
        });

        it("returns 'download' for mixed parquet+csv", async () => {
            const result = await resolveS3ReadMode(["data/file.parquet", "data/file.csv"]);
            expect(result).toBe("download");
        });

        it("returns 'download' for empty keys", async () => {
            const result = await resolveS3ReadMode([]);
            expect(result).toBe("download");
        });
    });

    describe("eligible files (all parquet)", () => {
        it("returns 'download' when setting is 'download'", async () => {
            const result = await resolveS3ReadMode(["data/file.parquet"], "download");
            expect(result).toBe("download");
            expect(mockShowQuickPick).not.toHaveBeenCalled();
        });

        it("returns 'range' when setting is 'range'", async () => {
            const result = await resolveS3ReadMode(["data/file.parquet"], "range");
            expect(result).toBe("range");
            expect(mockShowQuickPick).not.toHaveBeenCalled();
        });

        it("prompts user when setting is 'ask'", async () => {
            // Return the first item (range reads) from the items array
            mockShowQuickPick.mockImplementation(async (items: any[]) => items[0]);
            const result = await resolveS3ReadMode(["data/file.parquet"], "ask");
            expect(result).toBe("range");
            expect(mockShowQuickPick).toHaveBeenCalledTimes(1);
        });

        it("returns 'download' when user picks download option", async () => {
            mockShowQuickPick.mockImplementation(async (items: any[]) => items[1]);
            const result = await resolveS3ReadMode(["data/file.parquet"], "ask");
            expect(result).toBe("download");
        });

        it("returns undefined when user picks Cancel", async () => {
            mockShowQuickPick.mockImplementation(async (items: any[]) => items[2]);
            const result = await resolveS3ReadMode(["data/file.parquet"], "ask");
            expect(result).toBeUndefined();
        });

        it("returns undefined when user dismisses the picker", async () => {
            mockShowQuickPick.mockResolvedValue(undefined);
            const result = await resolveS3ReadMode(["data/file.parquet"], "ask");
            expect(result).toBeUndefined();
        });

        it("works for multiple parquet keys", async () => {
            mockShowQuickPick.mockImplementation(async (items: any[]) => items[0]);
            const result = await resolveS3ReadMode([
                "data/part-0.parquet",
                "data/part-1.parquet",
            ], "ask");
            expect(result).toBe("range");
        });

        it("prompts when a Parquet folder contains an unsupported marker", async () => {
            mockShowQuickPick.mockImplementation(async (items: any[]) => items[0]);
            const result = await resolveS3ReadMode([
                "data/part-0.parquet",
                "data/_SUCCESS",
            ], "ask");
            expect(result).toBe("range");
            expect(mockShowQuickPick).toHaveBeenCalledTimes(1);
        });
    });
});
