package zip

import (
	"archive/zip"
	"os"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
)

// partWriter wraps a single on-disk ZIP part file with a counting writer and a
// zip.Writer. Written() reports the compressed bytes flushed to disk so far,
// which the splitter uses to decide when to roll over to a new part.
type partWriter struct {
	key     string
	file    *os.File
	counter *countingWriter
	zw      *zip.Writer
}

func newPartWriter(ts *storage.TempStorage, key string) (*partWriter, error) {
	f, err := ts.Create(key)
	if err != nil {
		return nil, err
	}
	cw := &countingWriter{w: f}
	zw := zip.NewWriter(cw)
	return &partWriter{
		key:     key,
		file:    f,
		counter: cw,
		zw:      zw,
	}, nil
}

// Written returns the number of compressed bytes written to this part so far.
func (p *partWriter) Written() int64 {
	return p.counter.n
}

// Close finalizes the zip stream, flushes and closes the file, and returns the
// final part size in bytes.
func (p *partWriter) Close() (int64, error) {
	if err := p.zw.Close(); err != nil {
		p.file.Close()
		return 0, err
	}
	if err := p.file.Sync(); err != nil {
		p.file.Close()
		return 0, err
	}
	size := p.counter.n
	if err := p.file.Close(); err != nil {
		return 0, err
	}
	return size, nil
}

type countingWriter struct {
	w interface{ Write([]byte) (int, error) }
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}
