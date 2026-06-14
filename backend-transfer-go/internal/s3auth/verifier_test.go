// Package s3auth tests — golden fixtures ported from
// backend/src/s3/s3-auth.service.spec.ts to ensure byte-for-byte parity with
// the NestJS reference implementation.
package s3auth

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// silentLogger discards log output but keeps the slog API satisfied.
func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// makeReq builds an *http.Request matching the shape used in NestJS specs.
func makeReq(method, rawURL string, headers map[string]string) *http.Request {
	u, _ := url.Parse(rawURL)
	req := &http.Request{
		Method:     method,
		URL:        u,
		Header:     http.Header{},
		RequestURI: rawURL,
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return req
}

// ---------------------------------------------------------------------------
// awsUriEncode + normalizeHeaderValue
// ---------------------------------------------------------------------------

func TestAwsUriEncode_PreservesUnreserved(t *testing.T) {
	got := awsURIEncode("hello-world_~.AZ09")
	want := "hello-world_~.AZ09"
	if got != want {
		t.Errorf("awsUriEncode unreserved: got %q, want %q", got, want)
	}
}

func TestAwsUriEncode_EscapesReserved(t *testing.T) {
	got := awsURIEncode("a+b c!d'e(f)g*h")
	want := "a%2Bb%20c%21d%27e%28f%29g%2Ah"
	if got != want {
		t.Errorf("awsUriEncode reserved: got %q, want %q", got, want)
	}
}

func TestNormalizeHeaderValue_CollapsesWhitespace(t *testing.T) {
	got := normalizeHeaderValue("  a   b\t c  ")
	want := "a b c"
	if got != want {
		t.Errorf("normalizeHeaderValue: got %q, want %q", got, want)
	}
}

// ---------------------------------------------------------------------------
// Canonical URI — must match NestJS spec exactly
// ---------------------------------------------------------------------------

func TestBuildCanonicalUri_PreservesEncodedSpacesAndUnicode(t *testing.T) {
	in := "/s3/demo-bucket/archive/Project%20Files/Season%201/%5BClip%5D%20%E6%98%9F%E7%81%AB%20Demo%20A.mp4"
	got := buildCanonicalURI(in)
	if got != in {
		t.Errorf("canonical uri drift:\n got: %s\nwant: %s", got, in)
	}
}

func TestBuildCanonicalUri_PreservesPlusAndMojibakeSegments(t *testing.T) {
	in := "/s3/demo-bucket/gallery/%E8%A6%96%E8%A6%BA%20Test/%C2%BCsample%2B%2B%20%C2%A7-%C2%A7x/frame-3.gif"
	got := buildCanonicalURI(in)
	if got != in {
		t.Errorf("canonical uri drift:\n got: %s\nwant: %s", got, in)
	}
}

// ---------------------------------------------------------------------------
// Canonical Query String — sorting & literal plus handling
// ---------------------------------------------------------------------------

func TestBuildCanonicalQueryString_SortsDuplicateKeys(t *testing.T) {
	got := buildCanonicalQueryString("prefix=z&prefix=a&list-type=2&delimiter=%2F&max-keys=1000", "")
	want := "delimiter=%2F&list-type=2&max-keys=1000&prefix=a&prefix=z"
	if got != want {
		t.Errorf("query sort: got %q, want %q", got, want)
	}
}

func TestBuildCanonicalQueryString_PreservesLiteralPlus(t *testing.T) {
	// Matches NestJS s3-auth.service.spec.ts: literal `+` in a query value is
	// preserved (decode pipeline does NOT treat `+` as space), then re-encoded
	// as %2B. This is intentional — diverging would break aws-cli signatures.
	got := buildCanonicalQueryString("prefix=%2B%2B_mix.mp4&marker=a+b", "")
	want := "marker=a%2Bb&prefix=%2B%2B_mix.mp4"
	if got != want {
		t.Errorf("plus sign: got %q, want %q", got, want)
	}
}

func TestBuildCanonicalQueryString_ExcludesPresignedSignature(t *testing.T) {
	in := "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260501%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260501T010203Z&X-Amz-Expires=300&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host"
	got := buildCanonicalQueryString(in, "X-Amz-Signature")
	want := "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260501%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260501T010203Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host"
	if got != want {
		t.Errorf("presigned exclude:\n got: %s\nwant: %s", got, want)
	}
}

// ---------------------------------------------------------------------------
// parseAuthHeader
// ---------------------------------------------------------------------------

func TestParseAuthHeader_Valid(t *testing.T) {
	header := "AWS4-HMAC-SHA256 Credential=AKIATEST/20260613/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc123"
	parsed, err := parseAuthHeader(header)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if parsed.AccessKeyID != "AKIATEST" {
		t.Errorf("accessKeyId: got %q", parsed.AccessKeyID)
	}
	if parsed.Date != "20260613" || parsed.Region != "us-east-1" || parsed.Service != "s3" {
		t.Errorf("scope parts wrong: %+v", parsed)
	}
	if len(parsed.SignedHeaders) != 2 || parsed.SignedHeaders[0] != "host" {
		t.Errorf("signed headers: %+v", parsed.SignedHeaders)
	}
	if parsed.Signature != "abc123" {
		t.Errorf("signature: %q", parsed.Signature)
	}
}

func TestParseAuthHeader_InvalidPrefix(t *testing.T) {
	if _, err := parseAuthHeader("Basic xyz"); err == nil {
		t.Error("expected error for non-AWS4 prefix")
	}
}

// ---------------------------------------------------------------------------
// deriveSigningKey — AWS sample vector
// ---------------------------------------------------------------------------

func TestDeriveSigningKey_AwsExampleVector(t *testing.T) {
	// From AWS sigv4 docs: secret=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY,
	// date=20150830, region=us-east-1, service=iam → known signingKey hex
	const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
	const wantHex = "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"

	key := deriveSigningKey(secret, "20150830", "us-east-1", "iam")
	got := toHex(key)
	if got != wantHex {
		t.Errorf("signing key:\n got: %s\nwant: %s", got, wantHex)
	}
}

// ---------------------------------------------------------------------------
// End-to-end Verifier — uses a fake CredentialLookup
// ---------------------------------------------------------------------------

type fakeLookup struct {
	secret   string
	userID   string
	active   bool
	notFound bool
}

func (f *fakeLookup) Get(_ context.Context, _ string) (string, string, bool, error) {
	if f.notFound {
		return "", "", false, ErrCredentialNotFound
	}
	return f.secret, f.userID, f.active, nil
}

func TestVerifier_RejectsMissingAuthAndPresign(t *testing.T) {
	v := New(&fakeLookup{}, silentLogger())
	req := makeReq("HEAD", "/s3/bucket/key", map[string]string{"host": "example.com"})

	if _, err := v.Verify(context.Background(), req, "test-req"); err == nil {
		t.Error("expected ErrNoAuth when no auth present")
	}
}

func TestVerifier_RejectsExpiredPresignedUrl(t *testing.T) {
	old := time.Now().UTC().Add(-2 * time.Hour).Format("20060102T150405Z")
	cred := url.QueryEscape("AKIATEST/" + old[:8] + "/us-east-1/s3/aws4_request")
	rawURL := "/s3/bucket/file.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
		"&X-Amz-Credential=" + cred +
		"&X-Amz-Date=" + old +
		"&X-Amz-Expires=60" +
		"&X-Amz-SignedHeaders=host" +
		"&X-Amz-Signature=deadbeef"

	v := New(&fakeLookup{secret: "x", userID: "u", active: true}, silentLogger())
	req := makeReq("GET", rawURL, map[string]string{"host": "example.com"})

	_, err := v.Verify(context.Background(), req, "test-req")
	if err == nil || !strings.Contains(err.Error(), "expired") {
		t.Errorf("expected expired presign error, got %v", err)
	}
}

func TestVerifier_RejectsUnknownAccessKey(t *testing.T) {
	now := time.Now().UTC().Format("20060102T150405Z")
	header := "AWS4-HMAC-SHA256 Credential=AKIAUNKNOWN/" + now[:8] +
		"/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc"

	v := New(&fakeLookup{notFound: true}, silentLogger())
	req := makeReq("GET", "/s3/bucket/key", map[string]string{
		"host":          "example.com",
		"x-amz-date":    now,
		"authorization": header,
	})

	if _, err := v.Verify(context.Background(), req, "test-req"); err == nil {
		t.Error("expected ErrCredentialNotFound")
	}
}
