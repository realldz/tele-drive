package logger

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWinstonLogger(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "teledrive_logs_*")
	if err != nil {
		t.Fatalf("Failed to create temp log dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	logger, closer, err := InitLogger(tempDir, "debug")
	if err != nil {
		t.Fatalf("Failed to init logger: %v", err)
	}

	logger.Info("Starting transfer service test", slog.String("context", "Main"))
	logger.Debug("Debug test message", slog.String("context", "S3Service"))
	logger.Warn("Warning test message", slog.String("context", "TelegramService"))
	logger.Error("Error test message", slog.String("context", "CryptoEngine"), slog.String("stack", "stacktrace line 1\nstacktrace line 2"))

	closer.Close()

	day := time.Now().Format("2006-01-02")
	combinedPath := filepath.Join(tempDir, fmt.Sprintf("combined-%s.log", day))
	errorPath := filepath.Join(tempDir, fmt.Sprintf("error-%s.log", day))

	// Verify combined log file contents
	combinedLines := readLines(t, combinedPath)
	if len(combinedLines) != 4 {
		t.Errorf("Expected 4 log lines in combined file, got %d", len(combinedLines))
	}

	levels := []string{"info", "debug", "warn", "error"}
	contexts := []string{"Main", "S3Service", "TelegramService", "CryptoEngine"}

	for i, line := range combinedLines {
		var entry WinstonLogEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Errorf("Failed to parse JSON line %d: %v", i, err)
		}

		if entry.Timestamp == "" {
			t.Errorf("Empty timestamp on line %d", i)
		}
		if entry.Level != levels[i] {
			t.Errorf("Expected level %s, got %s on line %d", levels[i], entry.Level, i)
		}
		if entry.Context != contexts[i] {
			t.Errorf("Expected context %s, got %s on line %d", contexts[i], entry.Context, i)
		}
		if !strings.Contains(entry.Message, "test") && !strings.Contains(entry.Message, "Starting") {
			t.Errorf("Expected message to contain test key on line %d, got %s", i, entry.Message)
		}

		if entry.Level == "error" && entry.Stack == "" {
			t.Errorf("Expected stacktrace for error level, got empty on line %d", i)
		}
	}

	// Verify error log file contents
	errorLines := readLines(t, errorPath)
	if len(errorLines) != 1 {
		t.Errorf("Expected exactly 1 log line in error file, got %d", len(errorLines))
	}

	var errorEntry WinstonLogEntry
	if err := json.Unmarshal([]byte(errorLines[0]), &errorEntry); err != nil {
		t.Fatalf("Failed to parse JSON error line: %v", err)
	}

	if errorEntry.Level != "error" {
		t.Errorf("Expected level error in error file, got %s", errorEntry.Level)
	}
	if errorEntry.Context != "CryptoEngine" {
		t.Errorf("Expected context CryptoEngine in error file, got %s", errorEntry.Context)
	}
	if errorEntry.Stack == "" {
		t.Error("Expected error stacktrace, got empty")
	}
}

func readLines(t *testing.T, path string) []string {
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("Failed to open log file %s: %v", path, err)
	}
	defer file.Close()

	var lines []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("Scanner error: %v", err)
	}
	return lines
}
