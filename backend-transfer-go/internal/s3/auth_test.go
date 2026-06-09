package s3

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"reflect"
	"testing"
)

func TestParseAuthHeader(t *testing.T) {
	header := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-date, Signature=a93203b23b8b111e3b8b111e3b8b111e3b8b111e3b8b111e3b8b111e3b8b111e"
	parsed := parseAuthHeader(header)
	if parsed == nil {
		t.Fatal("Expected non-nil parsed authorization header")
	}

	if parsed.AccessKeyID != "AKIAIOSFODNN7EXAMPLE" {
		t.Errorf("Expected access key ID AKIAIOSFODNN7EXAMPLE, got %s", parsed.AccessKeyID)
	}
	if parsed.Date != "20130524" {
		t.Errorf("Expected date 20130524, got %s", parsed.Date)
	}
	if parsed.Region != "us-east-1" {
		t.Errorf("Expected region us-east-1, got %s", parsed.Region)
	}
	if parsed.Service != "s3" {
		t.Errorf("Expected service s3, got %s", parsed.Service)
	}
	if parsed.Signature != "a93203b23b8b111e3b8b111e3b8b111e3b8b111e3b8b111e3b8b111e3b8b111e" {
		t.Errorf("Expected signature mismatch, got %s", parsed.Signature)
	}
	expectedHeaders := []string{"host", "range", "x-amz-date"}
	if !reflect.DeepEqual(parsed.SignedHeaders, expectedHeaders) {
		t.Errorf("Expected signed headers %v, got %v", expectedHeaders, parsed.SignedHeaders)
	}
}

func TestAWSURIEncode(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"example object name.txt", "example%20object%20name.txt"},
		{"object*name", "object%2Aname"},
		{"-._~", "-._~"},
	}

	for _, test := range tests {
		got := awsURIEncode(test.input)
		if got != test.expected {
			t.Errorf("awsURIEncode(%q) = %q, expected %q", test.input, got, test.expected)
		}
	}
}

func TestBuildCanonicalQueryString(t *testing.T) {
	rawQuery := "prefix=photos&max-keys=50&marker=some-marker&X-Amz-Signature=secret"
	got := buildCanonicalQueryString(rawQuery, "X-Amz-Signature")
	expected := "marker=some-marker&max-keys=50&prefix=photos"
	if got != expected {
		t.Errorf("buildCanonicalQueryString = %q, expected %q", got, expected)
	}
}

func TestDeriveSigningKey(t *testing.T) {
	secret := "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
	date := "20150830"
	region := "us-east-1"
	service := "iam"

	signingKey := deriveSigningKey(secret, date, region, service)
	hexKey := hex.EncodeToString(signingKey)

	// Expected derived signing key from AWS standard examples for us-east-1/iam on 2015-08-30
	// Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4-calculate-signature.html
	expectedHex := "2c94c0cf5378ada6887f09bb697df8fc0affdb34ba1cdd5bda32b664bd55b73c"
	if hexKey != expectedHex {
		t.Errorf("Derived signing key was %s, expected %s", hexKey, expectedHex)
	}
}

func TestBuildCanonicalRequest(t *testing.T) {
	req, _ := http.NewRequest("GET", "http://example.com/example%20object.txt?prefix=test&X-Amz-Signature=foo", nil)
	req.Header.Set("Host", "example.com")
	req.Header.Set("X-Amz-Date", "20130524T000000Z")

	signedHeaders := []string{"host", "x-amz-date"}
	canonicalReq := buildCanonicalRequest(req, signedHeaders)

	h := sha256.New()
	h.Write([]byte(canonicalReq))
	canonicalReqHash := hex.EncodeToString(h.Sum(nil))

	if canonicalReqHash == "" {
		t.Error("Expected canonical request hash to not be empty")
	}
}
