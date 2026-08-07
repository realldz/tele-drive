/**
 * S3 error response helpers shared by BOTH S3 surfaces (`s3.controller.ts`
 * authenticated and `s3-public.controller.ts`).
 *
 * `splitS3ErrorCode` keeps `<Code>` a real S3 code: service errors thrown as
 * `NoSuchKey: <key>` are split on the first `: ` so aws-cli parses the code
 * instead of swallowing the whole string into `<Code>`.
 */

/** S3 error codes mapped to their HTTP status by the error renderers. */
export const S3_STATUS_MAP: Record<string, number> = {
  NoSuchBucket: 404,
  NoSuchKey: 404,
  BucketNotEmpty: 409,
  InvalidArgument: 400,
  BadDigest: 400,
  AccessDenied: 403,
  InvalidRequest: 400,
  ServiceUnavailable: 503,
  InternalError: 500,
};

/**
 * Split `'NoSuchKey: some/key'` into `{ code: 'NoSuchKey', message: 'some/key' }`.
 *
 * Splits on the first `: ` only when the leading token is a known S3 code.
 * Otherwise (no colon, or a colon inside an arbitrary message) the whole string
 * stays as-is on both sides — matching the historical behavior where code and
 * message were the same string.
 */
export function splitS3ErrorCode(
  raw: string,
  knownCodes: Readonly<Record<string, unknown>>,
): { code: string; message: string } {
  const separatorIndex = raw.indexOf(': ');
  if (separatorIndex === -1) return { code: raw, message: raw };
  const candidate = raw.slice(0, separatorIndex);
  if (!Object.prototype.hasOwnProperty.call(knownCodes, candidate)) {
    return { code: raw, message: raw };
  }
  return { code: candidate, message: raw.slice(separatorIndex + 2) };
}
