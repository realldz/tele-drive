package logger

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type DailyRotateWriter struct {
	mu         sync.Mutex
	dir        string
	prefix     string // "combined" or "error"
	currentDay string
	file       *os.File
}

var _ io.WriteCloser = (*DailyRotateWriter)(nil)

func NewDailyRotateWriter(dir, prefix string) (*DailyRotateWriter, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	w := &DailyRotateWriter{
		dir:    dir,
		prefix: prefix,
	}
	if err := w.rotate(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *DailyRotateWriter) rotate() error {
	day := time.Now().Format("2006-01-02")
	if w.file != nil && day == w.currentDay {
		return nil
	}

	if w.file != nil {
		w.file.Close()
	}

	filename := fmt.Sprintf("%s-%s.log", w.prefix, day)
	path := filepath.Join(w.dir, filename)

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}

	w.file = f
	w.currentDay = day
	return nil
}

func (w *DailyRotateWriter) Write(p []byte) (n int, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if err := w.rotate(); err != nil {
		return 0, err
	}

	return w.file.Write(p)
}

func (w *DailyRotateWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.file != nil {
		err := w.file.Close()
		w.file = nil
		return err
	}
	return nil
}
