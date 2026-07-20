import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockShowErrorMessage, mockGetConfiguration, mockAppendLine } = vi.hoisted(() => ({
    mockShowErrorMessage: vi.fn(),
    mockGetConfiguration: vi.fn(),
    mockAppendLine: vi.fn(),
}));

vi.mock("vscode", () => ({
    window: {
        showQuickPick: vi.fn(),
        showErrorMessage: mockShowErrorMessage,
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        withProgress: vi.fn(),
        createOutputChannel: vi.fn(() => ({ appendLine: mockAppendLine })),
    },
    workspace: {
        getConfiguration: mockGetConfiguration,
    },
    ProgressLocation: { Notification: 15 },
    EventEmitter: class { event = vi.fn(); fire = vi.fn(); dispose = vi.fn(); },
    Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }) },
}));

import { registerWithRangeRead } from "../../src/s3RangeRead";

// Mock the DuckDBEngine
function createMockEngine(createSecretError?: Error) {
    return {
        ensureHttpfs: vi.fn().mockResolvedValue(undefined),
        createScopedS3Secret: createSecretError
            ? vi.fn().mockRejectedValue(createSecretError)
            : vi.fn().mockResolvedValue("filesql_test_abc12345"),
        registerRangeTable: vi.fn().mockRejectedValue(new Error("Connection failed")),
        validateRangeRead: vi.fn().mockResolvedValue(undefined),
        dropS3Secret: vi.fn().mockResolvedValue(undefined),
        dropTable: vi.fn().mockResolvedValue(undefined),
    } as any;
}

function createMockRegistry() {
    return {
        add: vi.fn(),
        setLoadState: vi.fn(),
    } as any;
}

describe("S3 Range Read — Credential Safety", () => {
    const FAKE_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    const FAKE_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const FAKE_TOKEN = "FwoGZXIvYXdzEBYaDHqa0AP1L0M0ExAmPlEtOkEn123456789abcdefghijklm";
    const creds = { keyId: FAKE_KEY_ID, secret: FAKE_SECRET, token: FAKE_TOKEN };

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetConfiguration.mockReturnValue({
            get: (key: string, def: unknown) => {
                if (key === "s3ReadMode") return "range";
                return def;
            },
        });
    });

    describe("error messages shown to user do NOT contain credentials", () => {
        it("sanitizes AWS access key from error notification", async () => {
            // Simulate DuckDB throwing an error that includes the key in the message
            const errWithKey = new Error(
                `HTTP Error: Unable to connect to URL "s3://bucket/data.parquet". ` +
                `Key ID: ${FAKE_KEY_ID} is invalid.`
            );
            const engine = createMockEngine();
            engine.registerRangeTable.mockRejectedValue(errWithKey);
            mockShowErrorMessage.mockResolvedValue("Cancel");

            await registerWithRangeRead(
                { name: "test_table", filePath: "s3://bucket/data.parquet", fileType: "parquet", isS3: true },
                "bucket", "data/", ["data/data.parquet"], creds, "us-east-1",
                engine, createMockRegistry(), undefined,
            );

            // Verify the error message shown to user does not contain the actual key
            expect(mockShowErrorMessage).toHaveBeenCalled();
            const shownMsg = mockShowErrorMessage.mock.calls[0][0];
            expect(shownMsg).not.toContain(FAKE_KEY_ID);
            expect(shownMsg).toContain("[REDACTED_KEY]");
        });

        it("sanitizes long base64 tokens from error notification", async () => {
            const errWithToken = new Error(
                `Authentication failed. Token: ${FAKE_TOKEN}`
            );
            const engine = createMockEngine();
            engine.registerRangeTable.mockRejectedValue(errWithToken);
            mockShowErrorMessage.mockResolvedValue("Cancel");

            await registerWithRangeRead(
                { name: "test_table", filePath: "s3://bucket/data.parquet", fileType: "parquet", isS3: true },
                "bucket", "data/", ["data/data.parquet"], creds, "us-east-1",
                engine, createMockRegistry(), undefined,
            );

            const shownMsg = mockShowErrorMessage.mock.calls[0][0];
            expect(shownMsg).not.toContain(FAKE_TOKEN);
            expect(shownMsg).toContain("[REDACTED_TOKEN]");
        });

        it("sanitizes secret_access_key patterns from error notification", async () => {
            const errWithSecret = new Error(
                `Invalid credentials: secret_access_key=${FAKE_SECRET}`
            );
            const engine = createMockEngine();
            engine.registerRangeTable.mockRejectedValue(errWithSecret);
            mockShowErrorMessage.mockResolvedValue("Cancel");

            await registerWithRangeRead(
                { name: "test_table", filePath: "s3://bucket/data.parquet", fileType: "parquet", isS3: true },
                "bucket", "data/", ["data/data.parquet"], creds, "us-east-1",
                engine, createMockRegistry(), undefined,
            );

            const shownMsg = mockShowErrorMessage.mock.calls[0][0];
            expect(shownMsg).not.toContain(FAKE_SECRET);
        });
    });

    describe("logger output does NOT contain credential SQL", () => {
        it("logError for createScopedS3Secret failure does not include SQL with credentials", async () => {
            // Simulate CREATE SECRET failing — the error DuckDB returns
            const sqlError = new Error(
                `Parser Error: syntax error at or near "INVALID"`
            );
            const engine = createMockEngine(sqlError);
            mockShowErrorMessage.mockResolvedValue("Cancel");

            await registerWithRangeRead(
                { name: "test_table", filePath: "s3://bucket/data.parquet", fileType: "parquet", isS3: true },
                "bucket", "data/", ["data/data.parquet"], creds, "us-east-1",
                engine, createMockRegistry(), undefined,
            );

            // Check all logger output for credential material
            for (const call of mockAppendLine.mock.calls) {
                const loggedText = call[0] as string;
                expect(loggedText).not.toContain(FAKE_SECRET);
                expect(loggedText).not.toContain(FAKE_TOKEN);
                // KEY_ID may appear in a generic "AKIA..." pattern log but should not be
                // in the SQL context. Check it's not in a CREATE SECRET statement:
                expect(loggedText).not.toMatch(/CREATE.*SECRET.*AKIA/i);
                expect(loggedText).not.toMatch(/KEY_ID.*AKIA/i);
            }
        });
    });

    describe("fallback and cancel flows", () => {
        it("returns 'fallback' when user clicks 'Download instead' on error", async () => {
            const engine = createMockEngine();
            engine.registerRangeTable.mockRejectedValue(new Error("Network timeout"));
            mockShowErrorMessage.mockResolvedValue("Download instead");

            const result = await registerWithRangeRead(
                { name: "test_table", filePath: "s3://bucket/data.parquet", fileType: "parquet", isS3: true },
                "bucket", "data/", ["data/data.parquet"], creds, "us-east-1",
                engine, createMockRegistry(), undefined,
            );

            expect(result).toBe("fallback");
        });

        it("returns 'cancelled' when user clicks 'Cancel' on error", async () => {
            const engine = createMockEngine();
            engine.registerRangeTable.mockRejectedValue(new Error("Access denied"));
            mockShowErrorMessage.mockResolvedValue("Cancel");

            const result = await registerWithRangeRead(
                { name: "test_table", filePath: "s3://bucket/data.parquet", fileType: "parquet", isS3: true },
                "bucket", "data/", ["data/data.parquet"], creds, "us-east-1",
                engine, createMockRegistry(), undefined,
            );

            expect(result).toBe("cancelled");
        });

        it("returns 'cancelled' when user dismisses error dialog", async () => {
            const engine = createMockEngine();
            engine.registerRangeTable.mockRejectedValue(new Error("Access denied"));
            mockShowErrorMessage.mockResolvedValue(undefined);

            const result = await registerWithRangeRead(
                { name: "test_table", filePath: "s3://bucket/data.parquet", fileType: "parquet", isS3: true },
                "bucket", "data/", ["data/data.parquet"], creds, "us-east-1",
                engine, createMockRegistry(), undefined,
            );

            expect(result).toBe("cancelled");
        });

        it("cleans up secret and view on failure", async () => {
            const engine = createMockEngine();
            engine.registerRangeTable.mockRejectedValue(new Error("fail"));
            mockShowErrorMessage.mockResolvedValue("Cancel");

            await registerWithRangeRead(
                { name: "cleanup_test", filePath: "s3://bucket/data.parquet", fileType: "parquet", isS3: true },
                "bucket", "data/", ["data/data.parquet"], creds, "us-east-1",
                engine, createMockRegistry(), undefined,
            );

            expect(engine.dropS3Secret).toHaveBeenCalledWith("cleanup_test");
            expect(engine.dropTable).toHaveBeenCalledWith("cleanup_test");
        });
    });

    describe("no silent automatic download", () => {
        it("never falls back to download without explicit user action", async () => {
            const engine = createMockEngine();
            engine.registerRangeTable.mockRejectedValue(new Error("fail"));
            // User does NOT click "Download instead" — they dismiss
            mockShowErrorMessage.mockResolvedValue(undefined);

            const result = await registerWithRangeRead(
                { name: "test_table", filePath: "s3://bucket/data.parquet", fileType: "parquet", isS3: true },
                "bucket", "data/", ["data/data.parquet"], creds, "us-east-1",
                engine, createMockRegistry(), undefined,
            );

            // Must NOT be "fallback" — must be "cancelled"
            expect(result).not.toBe("fallback");
            expect(result).toBe("cancelled");
        });
    });
});
