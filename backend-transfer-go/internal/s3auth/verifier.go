// Package s3auth implements AWS Signature V4 verification for the S3-compatible
// gateway. It mirrors backend/src/s3/s3-auth.service.ts (NestJS reference) and
// is purposely free of DB / Redis access — credential resolution is delegated
// to a CredentialLookup interface so the same verifier can be exercised in
// unit tests with fakes and in production with the Redis+gRPC composite from
// Phase 3.
package s3auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// ctxKey is an unexported context-key type so values set by this package never
// collide with keys from other packages.
type ctxKey string

// redactKey masks an AWS access key ID for safe log output, showing only the
// first 4 characters followed by "****" to aid debugging without leaking the
// full credential identifier.
func redactKey(k string) string {
	if len(k) <= 4 {
		return "****"
	}
	return k[:4] + "****"
}

// requestIDKey carries the per-request correlation ID into the CredentialLookup
// impl so its cache/gRPC logs line up with the HTTP access log.
const requestIDKey ctxKey = "requestId"

const (
	algorithmHeader = "AWS4-HMAC-SHA256"
	// Header-based requests get a ±15 minute tolerance window. Beyond that
	// we treat the request as a replay attempt.
	maxClockSkew = 15 * time.Minute
)

// CredentialLookup resolves an accessKeyId to its plaintext secret + owning
// userId. Implementations: Phase 3 Redis-first composite, plus in-memory
// fakes for unit tests.
type CredentialLookup interface {
	// Get returns the credential for accessKeyId. If the credential does not
	// exist, return ErrCredentialNotFound. If it exists but is disabled, return
	// it with active=false (verifier will reject and log accordingly).
	Get(ctx context.Context, accessKeyId string) (secret string, userId string, active bool, err error)
}

// Verifier validates SigV4 requests against a credential store.
type Verifier struct {
	lookup CredentialLookup
	logger *slog.Logger
	// now is overridable for tests so skew-window assertions are deterministic.
	now func() time.Time
}

// New constructs a Verifier. Pass a non-nil logger; the package never silences
// failures internally — callers see the structured trail in the standard
// service logs.
func New(lookup CredentialLookup, logger *slog.Logger) *Verifier {
	return &Verifier{lookup: lookup, logger: logger, now: time.Now}
}

// SetClock overrides the clock; used by tests to pin "now" against fixture
// X-Amz-Date timestamps.
func (v *Verifier) SetClock(now func() time.Time) {
	v.now = now
}

// VerifyResult bundles the outcome so callers can attach userId to context
// without re-parsing the request.
type VerifyResult struct {
	UserID      string
	AccessKeyID string
	Presigned   bool
}

// Verify inspects the request, picks header vs presigned auth, validates the
// signature, and returns the authenticated userId. Errors map cleanly to
// the typed sentinel values in errors.go so middleware can translate them
// to S3 XML responses.
//
// The request is read-only — body is never consumed because SigV4 either uses
// `x-amz-content-sha256` (already signed by the client) or `UNSIGNED-PAYLOAD`.
func (v *Verifier) Verify(ctx context.Context, req *http.Request, requestID string) (*VerifyResult, error) {
	start := v.now()
	// Thread requestID through ctx so the CredentialLookup impl (Phase 3
	// CredentialResolver) can correlate its cache/gRPC logs with this request.
	ctx = context.WithValue(ctx, requestIDKey, requestID)
	authHeader := req.Header.Get("Authorization")
	hasAuthHeader := strings.HasPrefix(authHeader, algorithmHeader+" ")
	hasPresigned := req.URL.Query().Get("X-Amz-Algorithm") == algorithmHeader

	v.logger.Debug("s3auth.verify.start",
		"requestId", requestID,
		"method", req.Method,
		"path", req.URL.Path,
		"hasAuthHeader", hasAuthHeader,
		"hasPresignedQuery", hasPresigned,
	)

	var (
		result *VerifyResult
		err    error
	)
	switch {
	case hasAuthHeader:
		result, err = v.verifyHeader(ctx, req, authHeader, requestID)
	case hasPresigned:
		result, err = v.verifyPresigned(ctx, req, requestID)
	default:
		v.logger.Warn("s3auth.verify.no_auth",
			"requestId", requestID, "method", req.Method, "path", req.URL.Path)
		return nil, ErrNoAuth
	}

	dur := v.now().Sub(start)
	if err != nil {
		v.logger.Warn("s3auth.verify.result",
			"requestId", requestID,
			"method", req.Method,
			"path", req.URL.Path,
			"durationMs", dur.Milliseconds(),
			"reason", err.Error(),
		)
		return nil, err
	}

	v.logger.Debug("s3auth.verify.result",
		"requestId", requestID,
		"userId", result.UserID,
		"accessKeyId", redactKey(result.AccessKeyID),
		"presigned", result.Presigned,
		"durationMs", dur.Milliseconds(),
	)
	return result, nil
}

// verifyHeader handles requests authenticated via the Authorization header.
func (v *Verifier) verifyHeader(ctx context.Context, req *http.Request, authHeader, requestID string) (*VerifyResult, error) {
	parsed, err := parseAuthHeader(authHeader)
	if err != nil {
		v.logger.Debug("s3auth.parse.header_fail", "requestId", requestID, "error", err.Error())
		return nil, err
	}
	v.logger.Debug("s3auth.parse.header_ok",
		"requestId", requestID,
		"accessKeyId", redactKey(parsed.AccessKeyID),
		"signedHeaderCount", len(parsed.SignedHeaders),
	)

	dateTime := req.Header.Get("X-Amz-Date")
	if err := v.checkSkew(dateTime, requestID, parsed.AccessKeyID); err != nil {
		return nil, err
	}

	secret, userID, err := v.resolveCredential(ctx, parsed.AccessKeyID, requestID)
	if err != nil {
		return nil, err
	}

	canonical := buildCanonicalRequest(req, parsed.SignedHeaders)
	expected := computeSignature(canonical, dateTime, parsed.CredentialScope, parsed.Date, parsed.Region, parsed.Service, secret)

	if !hmac.Equal([]byte(expected), []byte(parsed.Signature)) {
		v.logger.Warn("s3auth.signature.mismatch",
			"requestId", requestID,
			"accessKeyId", redactKey(parsed.AccessKeyID),
		)
		// Dump structural debug info only; signatures, canonical request, and
		// header-derived fields are omitted from logs to prevent credential/secret
		// material from appearing in log sinks.
		v.logger.Debug("s3auth.signature.mismatch.detail",
			"requestId", requestID,
			"method", req.Method,
			"url", req.URL.RequestURI(),
			"signedHeaderCount", len(parsed.SignedHeaders),
		)
		return nil, ErrSignatureMismatch
	}

	v.logger.Debug("s3auth.signature.match", "requestId", requestID, "accessKeyId", redactKey(parsed.AccessKeyID))
	return &VerifyResult{UserID: userID, AccessKeyID: parsed.AccessKeyID, Presigned: false}, nil
}

// verifyPresigned handles query-string authenticated requests (e.g. share
// links generated by aws-cli `presign`).
func (v *Verifier) verifyPresigned(ctx context.Context, req *http.Request, requestID string) (*VerifyResult, error) {
	parsed, err := parsePresignedQuery(req.URL.Query())
	if err != nil {
		v.logger.Debug("s3auth.parse.presigned_fail", "requestId", requestID, "error", err.Error())
		return nil, err
	}
	v.logger.Debug("s3auth.parse.presigned_ok",
		"requestId", requestID,
		"accessKeyId", redactKey(parsed.AccessKeyID),
		"expiresSec", parsed.ExpiresSec,
		"signedHeaderCount", len(parsed.SignedHeaders),
	)

	if err := v.checkPresignedExpiry(parsed.DateTime, parsed.ExpiresSec, requestID, parsed.AccessKeyID); err != nil {
		return nil, err
	}

	secret, userID, err := v.resolveCredential(ctx, parsed.AccessKeyID, requestID)
	if err != nil {
		return nil, err
	}

	canonical := buildCanonicalRequestPresigned(req, parsed.SignedHeaders)
	expected := computeSignature(canonical, parsed.DateTime, parsed.CredentialScope, parsed.Date, parsed.Region, parsed.Service, secret)

	if !hmac.Equal([]byte(expected), []byte(parsed.Signature)) {
		v.logger.Warn("s3auth.signature.mismatch_presigned",
			"requestId", requestID, "accessKeyId", redactKey(parsed.AccessKeyID))
		// Signatures and canonical request omitted from logs to prevent
		// credential/secret material from appearing in log sinks.
		v.logger.Debug("s3auth.signature.mismatch_presigned.detail",
			"requestId", requestID,
			"signedHeaderCount", len(parsed.SignedHeaders),
		)
		return nil, ErrSignatureMismatch
	}

	v.logger.Debug("s3auth.signature.match", "requestId", requestID, "accessKeyId", redactKey(parsed.AccessKeyID))
	return &VerifyResult{UserID: userID, AccessKeyID: parsed.AccessKeyID, Presigned: true}, nil
}

// resolveCredential calls CredentialLookup and emits structured trace logs
// for hit / miss / inactive / error so Phase 3 cache stats can be reconstructed
// from logs alone if needed.
func (v *Verifier) resolveCredential(ctx context.Context, accessKeyID, requestID string) (secret string, userID string, err error) {
	v.logger.Debug("s3auth.cred.lookup.start", "requestId", requestID, "accessKeyId", redactKey(accessKeyID))

	secret, userID, active, err := v.lookup.Get(ctx, accessKeyID)
	if err != nil {
		if err == ErrCredentialNotFound {
			v.logger.Warn("s3auth.cred.lookup.miss",
				"requestId", requestID, "accessKeyId", redactKey(accessKeyID))
			return "", "", err
		}
		v.logger.Error("s3auth.cred.lookup.error",
			"requestId", requestID, "accessKeyId", redactKey(accessKeyID), "error", err.Error())
		return "", "", err
	}
	if !active {
		v.logger.Warn("s3auth.cred.lookup.inactive",
			"requestId", requestID, "accessKeyId", redactKey(accessKeyID), "userId", userID)
		return "", "", ErrCredentialInactive
	}

	v.logger.Debug("s3auth.cred.lookup.hit",
		"requestId", requestID, "accessKeyId", redactKey(accessKeyID), "userId", userID)
	return secret, userID, nil
}

// checkSkew enforces the 15-minute window for header-authenticated requests.
// Presigned URLs use checkPresignedExpiry instead since they carry an explicit
// X-Amz-Expires window.
func (v *Verifier) checkSkew(dateTime, requestID, accessKeyID string) error {
	if len(dateTime) != 16 {
		v.logger.Warn("s3auth.skew.bad_date_format",
			"requestId", requestID, "accessKeyId", redactKey(accessKeyID), "xAmzDate", dateTime)
		return ErrMalformed
	}
	t, err := parseAmzDate(dateTime)
	if err != nil {
		v.logger.Warn("s3auth.skew.bad_date_parse",
			"requestId", requestID, "accessKeyId", redactKey(accessKeyID), "xAmzDate", dateTime, "error", err.Error())
		return ErrMalformed
	}
	skew := absDuration(v.now().Sub(t))
	if skew > maxClockSkew {
		v.logger.Warn("s3auth.skew.too_old",
			"requestId", requestID, "accessKeyId", redactKey(accessKeyID), "skewSeconds", int64(skew.Seconds()))
		return ErrSkewTooLarge
	}
	v.logger.Debug("s3auth.skew.ok",
		"requestId", requestID, "accessKeyId", redactKey(accessKeyID), "skewSeconds", int64(skew.Seconds()))
	return nil
}

// checkPresignedExpiry rejects presigned URLs whose absolute expiry has passed.
func (v *Verifier) checkPresignedExpiry(dateTime string, expiresSec int, requestID, accessKeyID string) error {
	t, err := parseAmzDate(dateTime)
	if err != nil {
		v.logger.Warn("s3auth.presigned.bad_date",
			"requestId", requestID, "accessKeyId", redactKey(accessKeyID), "xAmzDate", dateTime)
		return ErrMalformed
	}
	expiresAt := t.Add(time.Duration(expiresSec) * time.Second)
	if v.now().After(expiresAt) {
		v.logger.Warn("s3auth.presigned.expired",
			"requestId", requestID, "accessKeyId", redactKey(accessKeyID), "expiresAt", expiresAt.UTC().Format(time.RFC3339))
		return ErrExpired
	}
	v.logger.Debug("s3auth.presigned.ok",
		"requestId", requestID, "accessKeyId", redactKey(accessKeyID), "expiresAt", expiresAt.UTC().Format(time.RFC3339))
	return nil
}

// computeSignature encapsulates the SigV4 string-to-sign + signing-key chain.
// Split out so both header and presigned paths share one well-tested impl.
func computeSignature(canonicalRequest, dateTime, credentialScope, date, region, service, secret string) string {
	hash := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := strings.Join([]string{
		algorithmHeader,
		dateTime,
		credentialScope,
		hex.EncodeToString(hash[:]),
	}, "\n")
	signingKey := deriveSigningKey(secret, date, region, service)
	mac := hmac.New(sha256.New, signingKey)
	mac.Write([]byte(stringToSign))
	return hex.EncodeToString(mac.Sum(nil))
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}
