# S3 client compatibility hardening

This note records the routing and protocol invariants needed by rclone, AWS CLI,
and other path-style S3 clients on the dedicated S3 domain.

## Dedicated-domain routing

Requests arrive as `/<bucket>` or `/<bucket>/<key>`. NestJS adds its internal
`/s3` controller prefix while preserving `originalUrl`, because SigV4 must be
checked against the URI sent by the client.

Bucket names are allowed to match internal route prefixes. In particular:

- bucket `s3` must become the internal path `/s3/s3`, not ListBuckets `/s3`;
- signed requests for buckets `public`, `transfer`, or names beginning with
  those strings must take precedence over the legacy public/transfer routes;
- unsigned `/public/...` and `/transfer/...` URLs keep their existing behavior.

The nginx split detects both Authorization-header signatures and presigned
`X-Amz-Algorithm` query strings. It forwards the original request URI unchanged.

## Listing behavior

ListObjects V2 uses opaque continuation tokens. ListObjects V1 uses the raw
`marker` key and returns `NextMarker` when truncated. Both versions share the
same UTF-8 byte ordering and exclusive cursor logic.

Bucket subresources such as `?versions`, `?uploads`, `?location`, and
`?versioning` are not implemented. They return `501 NotImplemented`; they must
never be mistaken for ordinary object listings.

## Upload safety

The Go data plane rejects PutObject requests whose decoded content length is
unknown or invalid before provisioning the destination. Treating unknown length
as zero can replace an existing object with an empty record before reading the
body.

CompleteMultipartUpload parses and validates every submitted part number and
ETag against stored chunks. The current storage model requires the manifest to
contain every uploaded part consecutively from part 1. Subset or sparse
completion returns `501 NotImplemented`; missing parts, reordered parts, and
ETag mismatches return S3 errors without completing the file. Standard per-part
checksum elements (`CRC32`, `CRC32C`, `CRC64NVME`, `SHA1`, and `SHA256`) emitted
by current AWS SDKs are accepted; integrity is still enforced against the stored
plaintext MD5 ETag.

UploadPart is always streamed on the original SigV4 URL. It must not use the
legacy `ENABLE_S3_PUT_REDIRECT` path: AWS CLI, rclone, and several SDKs do not
replay a signed request body to an HTTP 307 target.

## Authentication and error responses

SigV4 timestamps must match the complete `YYYYMMDDTHHMMSSZ` shape, represent a
real calendar time, and pass skew/expiration checks. Invalid timestamps are
rejected before credential lookup.

### Cloudflare `Accept-Encoding` rewrite

rclone uses the AWS SDK for Go, which signs `accept-encoding: identity` for
HEAD and `gzip` for GET (its S3 `use_accept_encoding_gzip` option) in
`SignedHeaders`. Cloudflare rewrites that header before it reaches the origin
(for example to `gzip, br`), so the ordinary canonical request no longer
matches. Both verifiers retry the signature with the client-signed values
(`identity` and `gzip`) when that header is signed and the observed value
differs:

- NestJS control plane: `backend/src/s3/s3-auth.service.ts`
- Go data plane: `backend-transfer-go/internal/s3auth/verifier.go`

Keep the two in sync. Fixing only one plane makes rclone work for ListObjects
(NestJS) but fail with 403 on GetObject/HeadObject/PutObject (Go).

Go S3 XML errors are built with XML encoding so object paths, messages, and
request IDs containing `&`, `<`, or other reserved characters remain valid XML.

## Regression coverage

- `s3-routing.middleware.spec.ts`: bucket-name collisions and signed URI
  preservation.
- `s3-list-v1.spec.ts`: V1 marker paging and unsupported bucket subresources.
- `s3-auth-time.spec.ts`: malformed, impossible, stale, and future timestamps.
- `s3-multipart-manifest.util.spec.ts`: part order, ETag validation, standard
  SDK checksum elements, numeric XML quote entities, and undeclared stored parts.
- `s3.controller.spec.ts`: UploadPart stays on the signed URL even when the
  legacy PutObject redirect flag is enabled.
- `s3_error_xml_test.go`: escaped XML errors and PutObject length handling.
- `verifier_test.go`: restores client-signed `accept-encoding: identity` and
  `gzip` after a Cloudflare rewrite on the Go data plane.
