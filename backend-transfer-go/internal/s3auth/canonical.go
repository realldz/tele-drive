// Package s3auth — canonical request builder per AWS SigV4 spec.
//
// Reference (TypeScript): backend/src/s3/s3-auth.service.ts
//   - buildCanonicalRequest
//   - buildCanonicalRequestPresigned
//   - buildCanonicalUri
//   - buildCanonicalQueryString
//
// Spec: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-create-canonical-request.html
package s3auth

import (
	"net/http"
	"sort"
	"strings"
)

// buildCanonicalRequest constructs the canonical request string for header-based
// SigV4 authentication. The payload hash comes from x-amz-content-sha256, with
// fallback to UNSIGNED-PAYLOAD (matches NestJS behavior).
func buildCanonicalRequest(req *http.Request, signedHeaders []string) string {
	method := strings.ToUpper(req.Method)
	rawPath, rawQuery := getRequestTarget(req)
	canonicalURI := buildCanonicalURI(rawPath)
	canonicalQuery := buildCanonicalQueryString(rawQuery, "")
	canonicalHeaders := buildCanonicalHeaders(req, signedHeaders)
	signedHeadersStr := strings.Join(signedHeaders, ";")

	payloadHash := req.Header.Get("X-Amz-Content-Sha256")
	if payloadHash == "" {
		payloadHash = "UNSIGNED-PAYLOAD"
	}

	return strings.Join([]string{
		method,
		canonicalURI,
		canonicalQuery,
		canonicalHeaders + "\n",
		signedHeadersStr,
		payloadHash,
	}, "\n")
}

// buildCanonicalRequestPresigned constructs the canonical request for presigned
// URL auth. Differs from header auth: X-Amz-Signature is excluded from query
// string; payload hash is always UNSIGNED-PAYLOAD.
func buildCanonicalRequestPresigned(req *http.Request, signedHeaders []string) string {
	method := strings.ToUpper(req.Method)
	rawPath, rawQuery := getRequestTarget(req)
	canonicalURI := buildCanonicalURI(rawPath)
	canonicalQuery := buildCanonicalQueryString(rawQuery, "X-Amz-Signature")
	canonicalHeaders := buildCanonicalHeaders(req, signedHeaders)
	signedHeadersStr := strings.Join(signedHeaders, ";")

	return strings.Join([]string{
		method,
		canonicalURI,
		canonicalQuery,
		canonicalHeaders + "\n",
		signedHeadersStr,
		"UNSIGNED-PAYLOAD",
	}, "\n")
}

// getRequestTarget returns the request path + query string as the client signed
// it. Mirrors NestJS getRequestTarget(req): prefers req.originalUrl, falls back
// to req.url. In Go we use the raw RequestURI when available (preserves the
// exact bytes the client sent), falling back to URL.Path / URL.RawQuery.
func getRequestTarget(req *http.Request) (path, query string) {
	target := req.RequestURI
	if target == "" {
		target = req.URL.Path
		if req.URL.RawQuery != "" {
			target += "?" + req.URL.RawQuery
		}
	}
	if target == "" {
		target = "/"
	}

	if idx := strings.Index(target, "?"); idx >= 0 {
		path = target[:idx]
		query = target[idx+1:]
	} else {
		path = target
		query = ""
	}
	if path == "" {
		path = "/"
	}
	return path, query
}

// buildCanonicalURI re-encodes each path segment per AWS rules. The path is
// split on '/', each segment is decoded then re-encoded with awsURIEncode so
// the result is normalized regardless of how the client encoded it.
func buildCanonicalURI(rawPath string) string {
	if rawPath == "" {
		return "/"
	}
	segments := strings.Split(rawPath, "/")
	for i, seg := range segments {
		decoded := safeDecodeURIComponent(seg)
		segments[i] = awsURIEncode(decoded)
	}
	return strings.Join(segments, "/")
}

// buildCanonicalQueryString sorts query pairs by encoded key (then encoded
// value) and rejoins them. excludedKey, when non-empty, drops a specific key
// (used for "X-Amz-Signature" in presigned URL auth).
//
// Critical: parsing decodes each pair, then re-encodes with awsURIEncode. This
// makes "+" in a value (which Go's net/url would treat as space) round-trip as
// the literal '+' character. Matches NestJS's manual decode/encode pipeline.
func buildCanonicalQueryString(rawQuery, excludedKey string) string {
	if rawQuery == "" {
		return ""
	}

	type pair struct {
		encodedKey   string
		encodedValue string
		key          string // raw decoded key for excludedKey comparison
	}

	rawPairs := strings.Split(rawQuery, "&")
	pairs := make([]pair, 0, len(rawPairs))

	for _, part := range rawPairs {
		if part == "" {
			continue
		}
		var rawKey, rawValue string
		if eq := strings.Index(part, "="); eq >= 0 {
			rawKey = part[:eq]
			rawValue = part[eq+1:]
		} else {
			rawKey = part
			rawValue = ""
		}
		key := safeDecodeURIComponent(rawKey)
		if excludedKey != "" && key == excludedKey {
			continue
		}
		value := safeDecodeURIComponent(rawValue)
		pairs = append(pairs, pair{
			encodedKey:   awsURIEncode(key),
			encodedValue: awsURIEncode(value),
			key:          key,
		})
	}

	sort.SliceStable(pairs, func(i, j int) bool {
		if pairs[i].encodedKey != pairs[j].encodedKey {
			return pairs[i].encodedKey < pairs[j].encodedKey
		}
		return pairs[i].encodedValue < pairs[j].encodedValue
	})

	out := make([]string, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, p.encodedKey+"="+p.encodedValue)
	}
	return strings.Join(out, "&")
}

// buildCanonicalHeaders builds the canonical headers block: lowercased name,
// trimmed/single-spaced value, one per line. Only includes headers in the
// signedHeaders list (preserves their order — already lowercased by parser).
//
// Reads from req.Header map directly (case-insensitive get is fine — Go
// canonicalizes header keys on insertion via textproto.CanonicalMIMEHeaderKey).
func buildCanonicalHeaders(req *http.Request, signedHeaders []string) string {
	lines := make([]string, 0, len(signedHeaders))
	for _, name := range signedHeaders {
		lower := strings.ToLower(name)
		var raw string
		// "host" is special: not in req.Header, only in req.Host.
		if lower == "host" {
			raw = req.Host
		} else {
			raw = req.Header.Get(name)
		}
		lines = append(lines, lower+":"+normalizeHeaderValue(raw))
	}
	return strings.Join(lines, "\n")
}
