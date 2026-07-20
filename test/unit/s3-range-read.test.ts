import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("../helpers/vscode-mock"));

import {
    isRangeReadEligible,
    isSingleKeyRangeEligible,
    rangeReadKeys,
    buildS3Uris,
    getConfig,
} from "../../src/s3Handler";

describe("S3 range-read eligibility", () => {
    describe("isSingleKeyRangeEligible", () => {
        it("returns true for .parquet (case-insensitive)", () => {
            expect(isSingleKeyRangeEligible("data/file.parquet")).toBe(true);
            expect(isSingleKeyRangeEligible("data/file.PARQUET")).toBe(true);
            expect(isSingleKeyRangeEligible("data/file.Parquet")).toBe(true);
        });

        it("returns false for non-parquet files", () => {
            expect(isSingleKeyRangeEligible("data/file.csv")).toBe(false);
            expect(isSingleKeyRangeEligible("data/file.json")).toBe(false);
            expect(isSingleKeyRangeEligible("data/file.txt")).toBe(false);
            expect(isSingleKeyRangeEligible("data/file.jsonl")).toBe(false);
        });

        it("returns false for empty string", () => {
            expect(isSingleKeyRangeEligible("")).toBe(false);
        });
    });

    describe("isRangeReadEligible", () => {
        it("returns true when all keys are .parquet", () => {
            expect(isRangeReadEligible([
                "data/part-001.parquet",
                "data/part-002.parquet",
                "data/part-003.PARQUET",
            ])).toBe(true);
        });

        it("returns false when keys are mixed types", () => {
            expect(isRangeReadEligible([
                "data/part-001.parquet",
                "data/metadata.json",
            ])).toBe(false);
        });

        it("returns false for all non-parquet keys", () => {
            expect(isRangeReadEligible([
                "data/file.csv",
                "data/file2.csv",
            ])).toBe(false);
        });

        it("returns false for empty keys array", () => {
            expect(isRangeReadEligible([])).toBe(false);
        });

        it("ignores unsupported marker objects", () => {
            const keys = [
                "data/part-001.parquet",
                "data/part-002.parquet",
                "data/_SUCCESS",
            ];
            expect(isRangeReadEligible(keys)).toBe(true);
            expect(rangeReadKeys(keys)).toEqual([
                "data/part-001.parquet",
                "data/part-002.parquet",
            ]);
        });

        it("does not ignore supported non-Parquet files", () => {
            const keys = ["data/part-001.parquet", "data/metadata.csv", "data/_SUCCESS"];
            expect(isRangeReadEligible(keys)).toBe(false);
            expect(rangeReadKeys(keys)).toEqual([]);
        });
    });

    describe("buildS3Uris", () => {
        it("builds full s3:// URIs from bucket and keys", () => {
            const result = buildS3Uris("my-bucket", ["path/file1.parquet", "path/file2.parquet"]);
            expect(result).toEqual([
                "s3://my-bucket/path/file1.parquet",
                "s3://my-bucket/path/file2.parquet",
            ]);
        });
    });
});

describe("getConfig s3ReadMode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns 'ask' as default s3ReadMode", () => {
        const config = getConfig();
        expect(config.s3ReadMode).toBe("ask");
    });
});
