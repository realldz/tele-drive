package storage

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
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
