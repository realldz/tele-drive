package s3auth

import (
	"strings"
)

// awsUriEncode encodes a string per AWS SigV4 spec.
// Differs from net/url.QueryEscape:
//   - Reserved chars per RFC 3986 unreserved: A-Z a-z 0-9 - _ . ~ left unencoded
//   - All others percent-encoded as %XX (uppercase hex)
//   - Notably: ! ' ( ) * + / = etc. ARE encoded.
//
// Used for canonical URI segments and canonical query string keys/values.
func awsURIEncode(s string) string {
	var b strings.Builder
	b.Grow(len(s) + len(s)/4)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isUnreserved(c) {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexUpper[c>>4])
		b.WriteByte(hexUpper[c&0x0F])
	}
	return b.String()
}

const hexUpper = "0123456789ABCDEF"

func isUnreserved(c byte) bool {
	switch {
	case c >= 'A' && c <= 'Z':
		return true
	case c >= 'a' && c <= 'z':
		return true
	case c >= '0' && c <= '9':
		return true
	case c == '-' || c == '_' || c == '.' || c == '~':
		return true
	}
	return false
}

// safeDecodeURIComponent mirrors NestJS safeDecodeURIComponent: returns the
// raw value if decode fails (malformed percent-encoding).
func safeDecodeURIComponent(s string) string {
	out, err := percentDecode(s)
	if err != nil {
		return s
	}
	return out
}

// percentDecode decodes %XX sequences into bytes; returns the original error
// for malformed input. We avoid net/url.QueryUnescape because it converts '+'
// to space, which breaks AWS canonicalization.
func percentDecode(s string) (string, error) {
	if !strings.ContainsRune(s, '%') {
		return s, nil
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '%' {
			b.WriteByte(c)
			continue
		}
		if i+2 >= len(s) {
			return "", ErrMalformed
		}
		hi, ok1 := unhex(s[i+1])
		lo, ok2 := unhex(s[i+2])
		if !ok1 || !ok2 {
			return "", ErrMalformed
		}
		b.WriteByte(hi<<4 | lo)
		i += 2
	}
	return b.String(), nil
}

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// normalizeHeaderValue collapses internal whitespace to a single space and
// trims leading/trailing whitespace, matching AWS SigV4 header value rules.
// Mirrors NestJS: value.trim().replace(/\s+/g, ' ').
func normalizeHeaderValue(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(v))
	prevSpace := false
	for i := 0; i < len(v); i++ {
		c := v[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteByte(c)
		prevSpace = false
	}
	return b.String()
}
