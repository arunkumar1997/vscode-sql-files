import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { expect, it } from "vitest";
import { DuckDBEngine } from "../../src/duckdbEngine";
import {
    detectBucketRegion,
    parseS3Uri,
    resolveAwsCredentials,
} from "../../src/s3Handler";
import { TableEntry } from "../../src/types";

const liveS3Uri = process.env.FILE_SQL_LIVE_S3_URI;
const profile = process.env.FILE_SQL_LIVE_AWS_PROFILE ?? process.env.AWS_PROFILE ?? "default";
const tableName = "live_range_probe";

function headerValue(row: Record<string, unknown>, key: string): string | undefined {
    const value = row[key];
    return value === null || value === undefined ? undefined : String(value);
}

function responseBytes(row: Record<string, unknown>): number | undefined {
    const contentRange = headerValue(row, "content_range");
    const match = contentRange?.match(/bytes\s+(\d+)-(\d+)\//i);
    if (match) {
        return Number(match[2]) - Number(match[1]) + 1;
    }

    const contentLength = headerValue(row, "content_length");
    if (contentLength && /^\d+$/.test(contentLength)) {
        return Number(contentLength);
    }
    return undefined;
}

function isPartialContent(row: Record<string, unknown>): boolean {
    const status = headerValue(row, "status");
    return status === "206" || status?.endsWith("_206") === true;
}

it("uses partial HTTP range GETs for a real S3 Parquet object", async () => {
    if (!liveS3Uri) {
        throw new Error(
            "Set FILE_SQL_LIVE_S3_URI=s3://bucket/path/large-file.parquet before running this live test.",
        );
    }

    const parsed = parseS3Uri(liveS3Uri);
    if (!parsed || parsed.isFolder || !parsed.prefix.toLowerCase().endsWith(".parquet")) {
        throw new Error("FILE_SQL_LIVE_S3_URI must identify one .parquet object, not a folder.");
    }

    const credentials = await resolveAwsCredentials(profile);
    const region = await detectBucketRegion(parsed.bucket, credentials);
    const client = new S3Client({
        region,
        credentials: {
            accessKeyId: credentials.keyId,
            secretAccessKey: credentials.secret,
            sessionToken: credentials.token,
        },
    });
    const metadata = await client
        .send(new HeadObjectCommand({ Bucket: parsed.bucket, Key: parsed.prefix }))
        .finally(() => client.destroy());
    const objectSize = metadata.ContentLength;
    if (!objectSize) {
        throw new Error("FILE_SQL_LIVE_S3_URI must identify a non-empty Parquet object.");
    }

    const engine = new DuckDBEngine();
    await engine.init();
    await engine.executeQuery("CALL enable_logging('HTTP')", 10);
    await engine.executeQuery("CALL truncate_duckdb_logs()", 10);

    const entry: TableEntry = {
        name: tableName,
        filePath: liveS3Uri,
        sourceUri: liveS3Uri,
        fileType: "parquet",
        isS3: true,
        readMode: "range",
    };

    try {
        await engine.createScopedS3Secret(
            tableName,
            parsed.bucket,
            parsed.prefix,
            credentials,
            region,
        );
        await engine.registerRangeTable(entry, [liveS3Uri], false);
        await engine.validateRangeRead(tableName);

        const queryTemplate = process.env.FILE_SQL_LIVE_S3_QUERY ??
            "SELECT COUNT(*) FROM {{table}}";
        if (!queryTemplate.includes("{{table}}")) {
            throw new Error("FILE_SQL_LIVE_S3_QUERY must contain the {{table}} placeholder.");
        }
        await engine.executeQuery(
            queryTemplate.replaceAll("{{table}}", `"${tableName}"`),
            1000,
        );

        const logs = await engine.executeQuery(
            `SELECT
         request.type AS method,
         coalesce(request.headers['Range'], request.headers['range']) AS range_header,
         response.status AS status,
         coalesce(response.headers['Content-Range'], response.headers['content-range']) AS content_range,
         coalesce(response.headers['Content-Length'], response.headers['content-length']) AS content_length
       FROM duckdb_logs_parsed('HTTP')
       WHERE upper(request.type) = 'GET'`,
            10000,
        );

        const rangedResponses = logs.rows.filter((row) =>
            headerValue(row, "range_header")?.toLowerCase().startsWith("bytes="),
        );
        const partialResponses = rangedResponses.filter(isPartialContent);
        const measuredBytes = partialResponses
            .map(responseBytes)
            .filter((value): value is number => value !== undefined)
            .reduce((total, value) => total + value, 0);

        console.info(
            `S3 range proof: object=${objectSize} bytes, ranged GETs=${rangedResponses.length}, ` +
            `206 responses=${partialResponses.length}, measured response bytes=${measuredBytes}`,
        );

        expect(rangedResponses.length, "DuckDB did not emit an HTTP GET with a Range header").toBeGreaterThan(0);
        expect(partialResponses.length, "S3 did not return 206 Partial Content").toBeGreaterThan(0);
        expect(measuredBytes, "HTTP logs did not expose response byte lengths").toBeGreaterThan(0);
        expect(
            measuredBytes,
            "The observed partial responses were not smaller than the complete object",
        ).toBeLessThan(objectSize);
    } finally {
        try { await engine.dropTable(tableName); } catch { /* best-effort live cleanup */ }
        try { await engine.dropS3Secret(tableName); } catch { /* best-effort live cleanup */ }
    }
});