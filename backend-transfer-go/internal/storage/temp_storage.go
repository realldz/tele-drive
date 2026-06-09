package storage

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
)

type TempStorage struct {
	baseDir string
}

func NewTempStorage(baseDir string) (*TempStorage, error) {
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return nil, err
	}
	return &TempStorage{baseDir: baseDir}, nil
}

func (s *TempStorage) Write(key string, data io.Reader) (int64, error) {
	filePath := filepath.Join(s.baseDir, key)
	if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		return 0, err
	}

	file, err := os.Create(filePath)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	return io.Copy(file, data)
}

func (s *TempStorage) WriteWithTimeout(ctx context.Context, key string, data io.Reader) (int64, error) {
	filePath := filepath.Join(s.baseDir, key)
	if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		return 0, err
	}
	file, err := os.Create(filePath)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	ctxReader := &contextReader{ctx: ctx, r: data}
	return io.Copy(file, ctxReader)
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (cr *contextReader) Read(p []byte) (int, error) {
	if err := cr.ctx.Err(); err != nil {
		return 0, err
	}
	return cr.r.Read(p)
}

func (s *TempStorage) WriteBytes(key string, data []byte) error {
	filePath := filepath.Join(s.baseDir, key)
	if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		return err
	}
	return os.WriteFile(filePath, data, 0644)
}

func (s *TempStorage) Read(key string) (io.ReadCloser, error) {
	filePath := filepath.Join(s.baseDir, key)
	return os.Open(filePath)
}

func (s *TempStorage) ReadRange(key string, offset, length int64) (io.ReadCloser, error) {
	filePath := filepath.Join(s.baseDir, key)
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}

	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		file.Close()
		return nil, err
	}

	return &limitReadCloser{
		r: io.LimitReader(file, length),
		c: file,
	}, nil
}

type limitReadCloser struct {
	r io.Reader
	c io.Closer
}

func (l *limitReadCloser) Read(p []byte) (n int, err error) {
	return l.r.Read(p)
}

func (l *limitReadCloser) Close() error {
	return l.c.Close()
}

func (s *TempStorage) Delete(key string) error {
	filePath := filepath.Join(s.baseDir, key)
	err := os.Remove(filePath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *TempStorage) Exists(key string) bool {
	filePath := filepath.Join(s.baseDir, key)
	_, err := os.Stat(filePath)
	return err == nil
}

func (s *TempStorage) GetUsedBytes() (int64, error) {
	return s.getDirSize(s.baseDir)
}

func (s *TempStorage) getDirSize(dirPath string) (int64, error) {
	var size int64
	err := filepath.Walk(dirPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // ignore path-specific errors
		}
		if !info.IsDir() {
			size += info.Size()
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("failed to traverse directory: %w", err)
	}
	return size, nil
}

// HasCapacity checks whether temp storage has room for a new file.
func (s *TempStorage) HasCapacity(settings *db.SettingsCache) bool {
	usedBytes, err := s.GetUsedBytes()
	if err != nil {
		return false
	}
	maxDiskMb := settings.GetCachedSettingInt64("MAX_BUFFER_DISK_MB", 2048)
	maxBytes := maxDiskMb * 1024 * 1024
	threshold := int64(float64(maxBytes) * 0.8)
	return usedBytes < threshold
}
