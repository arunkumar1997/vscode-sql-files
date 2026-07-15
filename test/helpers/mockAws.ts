import { vi } from "vitest";

/**
 * Mock factory for @aws-sdk/client-s3.
 * Call `mockS3Client()` to get a mock S3Client whose `.send()` you can control.
 */
export function createMockS3Client() {
  const sendFn = vi.fn();
  const client = { send: sendFn, destroy: vi.fn() };
  return { client, send: sendFn };
}

/**
 * Mock factory for @aws-sdk/credential-providers.
 * Returns a mock `fromIni` that resolves to fake creds.
 */
export function createMockFromIni(creds = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "FakeSessionToken",
}) {
  return vi.fn(() => vi.fn(async () => creds));
}
