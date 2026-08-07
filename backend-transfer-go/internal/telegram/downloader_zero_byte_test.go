package telegram

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
)

// zeroByteInfo reproduces exactly what GetDownloadInfo returns for a zero-byte
// object created by the A3 fix (PUT 0 bytes, non-slash key): status complete,
// no Telegram object (empty TelegramFileId), no chunks. GetDownloadInfo falls
// through to the chunked branch, producing IsChunked=true with an empty Chunks
// slice. A guard inside ServeDownload must handle this degenerate shape.
func zeroByteInfo() *DownloadInfo {
	return &DownloadInfo{
		ID:         "empty-file-id",
		Filename:   "empty.txt",
		Size:       0,
		MimeType:   "text/plain",
		IsBuffered: false,
		IsChunked:  true,
		Chunks:     []ChunkInfo{},
	}
}

func newZeroByteTestDownloader() *Downloader {
	return NewDownloader(
		nil, // telegramClient — unused for zero-byte
		nil, // cryptoEngine — unused for zero-byte
		nil, // tempStorage — unused for zero-byte
		nil, // redisClient — bandwidth disabled in test
		slog.New(slog.NewTextHandler(&discardWriter{}, nil)),
		false, // bandwidthEnabled
		nil,   // batchReporter
		nil,   // quotaResolver
		nil,   // settingsResolver → multiThread defaults to enabled
	)
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }

func (d *Downloader) serveDownloadWithRange(rangeHeader string) *httptest.ResponseRecorder {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/s3/b/empty.txt", nil)
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := d.ServeDownload(c, zeroByteInfo(), rangeHeader, "inline")
	if err != nil {
		panic(err)
	}
	return rec
}

// TestServeDownloadZeroByteNoRange — a plain (unranged) GET of a zero-byte
// object must return 200 with Content-Length: 0 and an empty body. Regression
// for the 416 the A3 fix introduced: GetDownloadInfo routes the zero-byte file
// to the chunked branch (IsChunked=true, empty Chunks), then ServeDownload's
// `start >= fileSize` guard (0 >= 0) tripped 416 RequestedRangeNotSatisfiable.
func TestServeDownloadZeroByteNoRange(t *testing.T) {
	d := newZeroByteTestDownloader()
	rec := d.serveDownloadWithRange("")

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for unranged GET of zero-byte object, got %d", rec.Code)
	}
	if cl := rec.Header().Get("Content-Length"); cl != "0" {
		t.Errorf("expected Content-Length: 0, got %q", cl)
	}
	if len(rec.Body.Bytes()) != 0 {
		t.Errorf("expected empty body, got %d bytes", len(rec.Body.Bytes()))
	}
}

// TestServeDownloadZeroByteRange — RFC 7233: a byte-range request against a
// zero-length representation is not satisfiable, so 416 is correct here even
// though the unranged GET is 200.
func TestServeDownloadZeroByteRange(t *testing.T) {
	for _, r := range []string{"bytes=0-", "bytes=-5", "bytes=0-0"} {
		t.Run(r, func(t *testing.T) {
			d := newZeroByteTestDownloader()
			rec := d.serveDownloadWithRange(r)

			if rec.Code != http.StatusRequestedRangeNotSatisfiable {
				t.Errorf("expected 416 for Range %q on zero-byte object, got %d", r, rec.Code)
			}
			if cr := rec.Header().Get("Content-Range"); cr != "bytes */0" {
				t.Errorf("expected Content-Range: bytes */0, got %q", cr)
			}
		})
	}
}

// zeroByteMeta mirrors the FileMetadata shape the control plane returns for a
// zero-byte FileRecord: status complete, empty TelegramFileId, no chunks.
func zeroByteMeta() *pb.FileMetadata {
	return &pb.FileMetadata{
		Id:             "empty-file-id",
		Filename:       "empty.txt",
		Size:           0,
		MimeType:       "text/plain",
		Status:         "complete",
		IsChunked:      false,
		TelegramFileId: "",
		Chunks:         []*pb.ChunkMetadata{},
	}
}

func (d *Downloader) serveStreamWithRange(rangeHeader string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	rec := httptest.NewRecorder()
	err := d.ServeStream(rec, req, zeroByteMeta())
	if err != nil {
		panic(err)
	}
	return rec
}

// TestServeStreamZeroByte — ServeStream is the S3 307-redirect token path and
// the web/signed download path; it shares the zero-byte 416 defect the A3 fix
// introduced. An unranged GET must be 200 empty, a Range request 416.
func TestServeStreamZeroByte(t *testing.T) {
	d := newZeroByteTestDownloader()

	rec := d.serveStreamWithRange("")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for unranged zero-byte ServeStream, got %d", rec.Code)
	}
	if cl := rec.Header().Get("Content-Length"); cl != "0" {
		t.Errorf("expected Content-Length: 0, got %q", cl)
	}
	if len(rec.Body.Bytes()) != 0 {
		t.Errorf("expected empty body, got %d bytes", len(rec.Body.Bytes()))
	}

	recRange := d.serveStreamWithRange("bytes=0-")
	if recRange.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Errorf("expected 416 for Range bytes=0- on zero-byte ServeStream, got %d", recRange.Code)
	}
}
