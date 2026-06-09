package logger

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"strings"
)

type WinstonLogEntry struct {
	Timestamp string `json:"timestamp"`
	Level     string `json:"level"`
	Context   string `json:"context,omitempty"`
	Message   string `json:"message"`
	Stack     string `json:"stack,omitempty"`
}

type WinstonHandler struct {
	writer io.Writer
	level  slog.Level
	attrs  []slog.Attr
	groups []string
}

var _ slog.Handler = (*WinstonHandler)(nil)

func NewWinstonHandler(w io.Writer, level slog.Level) *WinstonHandler {
	return &WinstonHandler{
		writer: w,
		level:  level,
	}
}

func (h *WinstonHandler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= h.level
}

func (h *WinstonHandler) Handle(_ context.Context, r slog.Record) error {
	entry := WinstonLogEntry{
		Timestamp: r.Time.Format("2006-01-02 15:04:05.000"),
		Level:     mapLevel(r.Level),
		Message:   r.Message,
	}

	// Apply contextual attributes from WithAttrs
	for _, a := range h.attrs {
		h.applyAttr(&entry, a)
	}

	// Extract context, stack, and other custom attributes from record
	r.Attrs(func(a slog.Attr) bool {
		h.applyAttr(&entry, a)
		return true
	})

	// Format as JSON and write with newline
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	_, err = h.writer.Write(append(data, '\n'))
	return err
}

func (h *WinstonHandler) applyAttr(entry *WinstonLogEntry, a slog.Attr) {
	switch a.Key {
	case "context":
		entry.Context = a.Value.String()
	case "stack":
		entry.Stack = a.Value.String()
	case "error":
		if err, ok := a.Value.Any().(error); ok {
			entry.Message = entry.Message + ": " + err.Error()
		} else {
			entry.Message = entry.Message + ": " + a.Value.String()
		}
	}
}

func (h *WinstonHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	newAttrs := append([]slog.Attr(nil), h.attrs...)
	newAttrs = append(newAttrs, attrs...)
	return &WinstonHandler{
		writer: h.writer,
		level:  h.level,
		attrs:  newAttrs,
		groups: h.groups,
	}
}

func (h *WinstonHandler) WithGroup(name string) slog.Handler {
	return &WinstonHandler{
		writer: h.writer,
		level:  h.level,
		attrs:  h.attrs,
		groups: append(h.groups, name),
	}
}

func mapLevel(l slog.Level) string {
	switch l {
	case slog.LevelDebug:
		return "debug"
	case slog.LevelInfo:
		return "info"
	case slog.LevelWarn:
		return "warn"
	case slog.LevelError:
		return "error"
	default:
		return "info"
	}
}

type MultiHandler struct {
	handlers []slog.Handler
}

var _ slog.Handler = (*MultiHandler)(nil)

func NewMultiHandler(handlers ...slog.Handler) *MultiHandler {
	return &MultiHandler{handlers: handlers}
}

func (m *MultiHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range m.handlers {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (m *MultiHandler) Handle(ctx context.Context, r slog.Record) error {
	for _, h := range m.handlers {
		if h.Enabled(ctx, r.Level) {
			_ = h.Handle(ctx, r)
		}
	}
	return nil
}

func (m *MultiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	handlers := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		handlers[i] = h.WithAttrs(attrs)
	}
	return NewMultiHandler(handlers...)
}

func (m *MultiHandler) WithGroup(name string) slog.Handler {
	handlers := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		handlers[i] = h.WithGroup(name)
	}
	return NewMultiHandler(handlers...)
}

// InitLogger initializes the global slog Logger
func InitLogger(logDir, logLevelStr string) (*slog.Logger, io.Closer, error) {
	level := slog.LevelInfo
	switch strings.ToLower(logLevelStr) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}

	// Create daily rotate writers
	combinedWriter, err := NewDailyRotateWriter(logDir, "combined")
	if err != nil {
		return nil, nil, err
	}

	errorWriter, err := NewDailyRotateWriter(logDir, "error")
	if err != nil {
		combinedWriter.Close()
		return nil, nil, err
	}

	// Set up handlers
	consoleHandler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: level,
	})

	combinedFileHandler := NewWinstonHandler(combinedWriter, level)
	errorFileHandler := NewWinstonHandler(errorWriter, slog.LevelError)

	multiHandler := NewMultiHandler(consoleHandler, combinedFileHandler, errorFileHandler)
	logger := slog.New(multiHandler)

	slog.SetDefault(logger)

	closer := &multiCloser{
		closers: []io.Closer{combinedWriter, errorWriter},
	}

	return logger, closer, nil
}

type multiCloser struct {
	closers []io.Closer
}

func (c *multiCloser) Close() error {
	var firstErr error
	for _, cl := range c.closers {
		if err := cl.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
