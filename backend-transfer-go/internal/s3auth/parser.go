// Package s3auth — parse Authorization header and presigned URL params.
package s3auth

import (
	"net/url"
	"strings"
)

// AuthHeader holds the parsed AWS4-HMAC-SHA256 Authorization header components.
type AuthHeader struct {
	AccessKeyID     string
	Date            string // YYYYMMDD
	Region          string
	Service         string
	CredentialScope string // <date>/<region>/<service>/aws4_request
	SignedHeaders   []string
	Signature       string
}

// PresignedQuery holds the parsed presigned URL query parameters.
type PresignedQuery struct {
	AccessKeyID     string
	Date            string // YYYYMMDD
	Region          string
	Service         string
	CredentialScope string
	DateTime        string // YYYYMMDDTHHMMSSZ (X-Amz-Date)
	ExpiresSec      int    // seconds
	SignedHeaders   []string
	Signature       string
}

// parseAuthHeader parses "AWS4-HMAC-SHA256 Credential=...,SignedHeaders=...,Signature=...".
// Returns ErrMalformed if the header is malformed.
func parseAuthHeader(authHeader string) (*AuthHeader, error) {
	const prefix = "AWS4-HMAC-SHA256 "
	if !strings.HasPrefix(authHeader, prefix) {
		return nil, ErrMalformed
	}
	body := strings.TrimPrefix(authHeader, prefix)

	parts := map[string]string{}
	for _, p := range splitTopLevel(body, ',') {
		p = strings.TrimSpace(p)
		eq := strings.IndexByte(p, '=')
		if eq < 0 {
			continue
		}
		parts[strings.TrimSpace(p[:eq])] = strings.TrimSpace(p[eq+1:])
	}

	credential := parts["Credential"]
	signedHeadersStr := parts["SignedHeaders"]
	signature := parts["Signature"]
	if credential == "" || signedHeadersStr == "" || signature == "" {
		return nil, ErrMalformed
	}

	credParts := strings.Split(credential, "/")
	if len(credParts) < 5 {
		return nil, ErrMalformed
	}

	return &AuthHeader{
		AccessKeyID:     credParts[0],
		Date:            credParts[1],
		Region:          credParts[2],
		Service:         credParts[3],
		CredentialScope: strings.Join(credParts[1:], "/"),
		SignedHeaders:   strings.Split(signedHeadersStr, ";"),
		Signature:       signature,
	}, nil
}

// parsePresignedQuery extracts SigV4 presigned URL parameters from a parsed url.Values.
// Returns ErrMalformed when required keys are missing or invalid.
func parsePresignedQuery(q url.Values) (*PresignedQuery, error) {
	algorithm := q.Get("X-Amz-Algorithm")
	if algorithm != "AWS4-HMAC-SHA256" {
		return nil, ErrMalformed
	}

	credentialStr := q.Get("X-Amz-Credential")
	dateTime := q.Get("X-Amz-Date")
	expiresStr := q.Get("X-Amz-Expires")
	signedHeadersStr := q.Get("X-Amz-SignedHeaders")
	signature := q.Get("X-Amz-Signature")

	if credentialStr == "" || dateTime == "" || expiresStr == "" || signedHeadersStr == "" || signature == "" {
		return nil, ErrMalformed
	}

	credParts := strings.Split(credentialStr, "/")
	if len(credParts) < 5 {
		return nil, ErrMalformed
	}

	expires, err := atoiStrict(expiresStr)
	if err != nil || expires < 1 || expires > 604800 { // max 7 days per AWS spec
		return nil, ErrMalformed
	}

	return &PresignedQuery{
		AccessKeyID:     credParts[0],
		Date:            credParts[1],
		Region:          credParts[2],
		Service:         credParts[3],
		CredentialScope: strings.Join(credParts[1:], "/"),
		DateTime:        dateTime,
		ExpiresSec:      expires,
		SignedHeaders:   strings.Split(signedHeadersStr, ";"),
		Signature:       signature,
	}, nil
}

// splitTopLevel splits s on sep, ignoring sep inside quoted regions (none in SigV4
// auth header — but defensive).
func splitTopLevel(s string, sep byte) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

func atoiStrict(s string) (int, error) {
	n := 0
	if s == "" {
		return 0, ErrMalformed
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, ErrMalformed
		}
		n = n*10 + int(c-'0')
		if n > 1<<30 {
			return 0, ErrMalformed
		}
	}
	return n, nil
}
