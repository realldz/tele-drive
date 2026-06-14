// Package s3auth verifies AWS Signature Version 4 on incoming HTTP requests.
//
// Pure-function package: no DB / Redis / network. Callers inject a
// CredentialLookup. Used by S3 GET / HEAD / PUT handlers.
package s3auth

import "errors"

// Verification failure modes.
//
// Verify returns one of these wrapped via fmt.Errorf("...%w", err) so callers
// can pattern-match with errors.Is and translate to S3 wire codes:
//
//   ErrMalformed          -> 400 InvalidRequest
//   ErrCredentialNotFound -> 403 InvalidAccessKeyId
//   ErrCredentialInactive -> 403 InvalidAccessKeyId
//   ErrSignatureMismatch  -> 403 SignatureDoesNotMatch
//   ErrSkewTooLarge       -> 403 RequestTimeTooSkewed
//   ErrExpired            -> 403 AccessDenied (presigned URL expired)
var (
	ErrMalformed          = errors.New("malformed sigv4 request")
	ErrCredentialNotFound = errors.New("access key not found")
	ErrCredentialInactive = errors.New("access key inactive")
	ErrSignatureMismatch  = errors.New("signature mismatch")
	ErrSkewTooLarge       = errors.New("request timestamp skew too large")
	ErrExpired            = errors.New("presigned url expired")
	ErrNoAuth             = errors.New("no sigv4 credentials supplied")
)
