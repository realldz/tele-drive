// Package handler tests — aws-chunked decoder parity with the NestJS
// AwsChunkedDecodeStream reference (backend/src/s3/aws-chunked-decode.stream.ts).
package handler

import (
	"io"
	"strings"
	"testing"
)

// readAll drains an awsChunkedReader and returns the decoded payload + error.
func readAll(t *testing.T, wire string) ([]byte, error) {
	t.Helper()
	r := newAwsChunkedReader(strings.NewReader(wire))
	return io.ReadAll(r)
}

func TestAwsChunked_SingleChunk(t *testing.T) {
	// "hello" = 5 bytes = 0x5
	wire := "5;chunk-signature=abc\r\nhello\r\n0;chunk-signature=def\r\n\r\n"
	got, err := readAll(t, wire)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != "hello" {
		t.Errorf("got %q, want %q", got, "hello")
	}
}

func TestAwsChunked_MultipleChunks(t *testing.T) {
	// "hello" (5) + "world!" (6 = 0x6) → "helloworld!"
	wire := "5;chunk-signature=x\r\nhello\r\n6;chunk-signature=y\r\nworld!\r\n0\r\n\r\n"
	got, err := readAll(t, wire)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != "helloworld!" {
		t.Errorf("got %q, want %q", got, "helloworld!")
	}
}

func TestAwsChunked_NoChunkSignatureExtension(t *testing.T) {
	// Plain size header without ";chunk-signature=" extension.
	wire := "4\r\ntest\r\n0\r\n\r\n"
	got, err := readAll(t, wire)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != "test" {
		t.Errorf("got %q, want %q", got, "test")
	}
}

func TestAwsChunked_WithTrailers(t *testing.T) {
	// Final chunk followed by a trailer header then blank line.
	wire := "3\r\nabc\r\n0\r\nx-amz-checksum-crc32:AAAAAA==\r\n\r\n"
	got, err := readAll(t, wire)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != "abc" {
		t.Errorf("got %q, want %q", got, "abc")
	}
}

func TestAwsChunked_EmptyPayload(t *testing.T) {
	// Zero-length payload: immediate final chunk.
	wire := "0\r\n\r\n"
	got, err := readAll(t, wire)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %q, want empty", got)
	}
}

func TestAwsChunked_TruncatedData(t *testing.T) {
	// Declares 10 bytes but only 4 present → ErrUnexpectedEOF.
	wire := "a\r\nshor"
	_, err := readAll(t, wire)
	if err != io.ErrUnexpectedEOF {
		t.Errorf("got %v, want ErrUnexpectedEOF", err)
	}
}

func TestAwsChunked_InvalidChunkSize(t *testing.T) {
	wire := "zz\r\ndata\r\n0\r\n\r\n"
	_, err := readAll(t, wire)
	if err == nil {
		t.Error("expected error for non-hex chunk size")
	}
}

func TestAwsChunked_MalformedTerminator(t *testing.T) {
	// Data chunk not followed by CRLF.
	wire := "3\r\nabcXX0\r\n\r\n"
	_, err := readAll(t, wire)
	if err == nil {
		t.Error("expected error for malformed data terminator")
	}
}
