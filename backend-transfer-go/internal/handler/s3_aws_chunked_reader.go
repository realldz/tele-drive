package handler

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// awsChunkedReader decodes the `aws-chunked` transfer encoding that aws-cli /
// SDKs use for streaming uploads (Content-Encoding: aws-chunked,
// x-amz-content-sha256: STREAMING-AWS4-HMAC-SHA256-PAYLOAD).
//
// Wire format is a series of chunks:
//
//	<sizeHex>[;chunk-signature=...]\r\n
//	<raw bytes of length sizeHex>\r\n
//	...
//	0[;chunk-signature=...]\r\n
//	[trailer-name:trailer-value\r\n]...
//	\r\n
//
// It exposes the decoded payload as a plain io.Reader so the upload pipeline can
// stream straight to Telegram. Per-chunk signatures are NOT verified — the
// SigV4 seed signature on the request headers already authenticates the sender
// (matching the NestJS AwsChunkedDecodeStream, which also skips them).
type awsChunkedReader struct {
	br      *bufio.Reader
	remain  int64 // bytes left in the current data chunk
	started bool
	done    bool
	err     error
}

func newAwsChunkedReader(r io.Reader) *awsChunkedReader {
	return &awsChunkedReader{br: bufio.NewReader(r)}
}

func (a *awsChunkedReader) Read(p []byte) (int, error) {
	if a.err != nil {
		return 0, a.err
	}
	if a.done {
		return 0, io.EOF
	}

	// Advance to the next data chunk when the current one is exhausted.
	if a.remain == 0 {
		if err := a.nextChunk(); err != nil {
			a.err = err
			return 0, err
		}
		if a.done {
			return 0, io.EOF
		}
	}

	// Read no more than what remains in the current chunk.
	toRead := int64(len(p))
	if toRead > a.remain {
		toRead = a.remain
	}
	n, err := a.br.Read(p[:toRead])
	a.remain -= int64(n)

	// Consume the trailing CRLF once the chunk's data is fully read.
	if a.remain == 0 && err == nil {
		if crlfErr := a.consumeCRLF(); crlfErr != nil {
			a.err = crlfErr
			return n, crlfErr
		}
	}
	if err == io.EOF {
		// EOF mid-chunk means the body was truncated before the declared size.
		a.err = io.ErrUnexpectedEOF
		return n, a.err
	}
	return n, err
}

// nextChunk reads a chunk-size header line and sets remain. A zero size starts
// the trailer section and terminates the stream.
func (a *awsChunkedReader) nextChunk() error {
	// Between chunks (not the first), the previous data's CRLF was already
	// consumed in Read; the header line follows directly.
	a.started = true

	line, err := a.readLine()
	if err != nil {
		return err
	}

	// Strip any chunk-signature extension: "<hex>;chunk-signature=..."
	sizeHex := line
	if i := strings.IndexByte(line, ';'); i != -1 {
		sizeHex = line[:i]
	}
	sizeHex = strings.TrimSpace(sizeHex)
	if sizeHex == "" {
		return fmt.Errorf("aws-chunked: empty chunk size in %q", line)
	}

	size, err := strconv.ParseInt(sizeHex, 16, 64)
	if err != nil || size < 0 {
		return fmt.Errorf("aws-chunked: invalid chunk size %q", sizeHex)
	}

	if size == 0 {
		// Final chunk — drain trailers until a blank line, then we're done.
		if trailErr := a.consumeTrailers(); trailErr != nil {
			return trailErr
		}
		a.done = true
		return nil
	}

	a.remain = size
	return nil
}

// consumeCRLF reads the mandatory \r\n that terminates a data chunk.
func (a *awsChunkedReader) consumeCRLF() error {
	b0, err := a.br.ReadByte()
	if err != nil {
		return err
	}
	b1, err := a.br.ReadByte()
	if err != nil {
		return err
	}
	if b0 != '\r' || b1 != '\n' {
		return errors.New("aws-chunked: malformed data terminator (expected CRLF)")
	}
	return nil
}

// consumeTrailers reads optional trailer header lines after the final chunk
// until a blank line. Trailer values are discarded (not needed downstream).
func (a *awsChunkedReader) consumeTrailers() error {
	for {
		line, err := a.readLine()
		if err != nil {
			// Some clients omit the closing blank line and just EOF.
			if err == io.EOF {
				return nil
			}
			return err
		}
		if line == "" {
			return nil
		}
		// A non-empty line is a "name:value" trailer; ignore its content.
	}
}

// readLine reads a single CRLF-terminated line and returns it without the CRLF.
func (a *awsChunkedReader) readLine() (string, error) {
	line, err := a.br.ReadString('\n')
	if err != nil {
		if err == io.EOF && line == "" {
			return "", io.EOF
		}
		if err != io.EOF {
			return "", err
		}
	}
	return strings.TrimRight(line, "\r\n"), nil
}
