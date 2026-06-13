package zip

import (
	"archive/zip"
	"context"
	"fmt"
	"log/slog"
	"path"
	"strings"
	"sync"
	"time"

	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
)

// PartSize is the maximum size of a single ZIP part before splitting (2GB).
const PartSize int64 = 2 * 1024 * 1024 * 1024

// CoreClient is the subset of the gRPC core client the ZIP worker needs.
type CoreClient interface {
	CollectZipEntries(ctx context.Context, jobID string) ([]*pb.ZipEntry, error)
	GetFileMetadata(ctx context.Context, fileID string) (*pb.FileMetadata, error)
	ReportZipProgress(ctx context.Context, jobID string, processedFiles int32) error
	ReportZipReady(ctx context.Context, req *pb.ReportZipReadyRequest) error
	ReportZipFailed(ctx context.Context, jobID string, reason string) error
}

// Worker assembles ZIP archives from Telegram-stored files entirely in Go.
type Worker struct {
	client      CoreClient
	downloader  *telegram.Downloader
	tempStorage *storage.TempStorage
	logger      *slog.Logger

	mu      sync.Mutex
	running map[string]struct{}
}

func NewWorker(client CoreClient, downloader *telegram.Downloader, tempStorage *storage.TempStorage, logger *slog.Logger) *Worker {
	return &Worker{
		client:      client,
		downloader:  downloader,
		tempStorage: tempStorage,
		logger:      logger,
		running:     make(map[string]struct{}),
	}
}

// Process runs a single ZIP job asynchronously. It is safe to call concurrently
// for different jobIDs; duplicate jobIDs already in progress are ignored.
func (w *Worker) Process(jobID string) {
	w.mu.Lock()
	if _, ok := w.running[jobID]; ok {
		w.mu.Unlock()
		w.logger.Warn("ZIP job already running, ignoring duplicate", "jobId", jobID)
		return
	}
	w.running[jobID] = struct{}{}
	w.mu.Unlock()

	go func() {
		defer func() {
			w.mu.Lock()
			delete(w.running, jobID)
			w.mu.Unlock()
		}()

		if err := w.run(jobID); err != nil {
			w.logger.Error("ZIP job failed", "jobId", jobID, "error", err)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if rerr := w.client.ReportZipFailed(ctx, jobID, err.Error()); rerr != nil {
				w.logger.Error("Failed to report ZIP failure", "jobId", jobID, "error", rerr)
			}
			w.cleanup(jobID)
		}
	}()
}

func (w *Worker) run(jobID string) error {
	ctx := context.Background()

	entries, err := w.client.CollectZipEntries(ctx, jobID)
	if err != nil {
		return fmt.Errorf("collect entries: %w", err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("no files to download")
	}

	w.logger.Info("ZIP job started", "jobId", jobID, "files", len(entries))

	parts, totalSize, err := w.createZip(ctx, jobID, entries)
	if err != nil {
		return err
	}

	ready := &pb.ReportZipReadyRequest{
		JobId:     jobID,
		Parts:     parts,
		TotalSize: totalSize,
		Streaming: false,
	}
	if err := w.client.ReportZipReady(ctx, ready); err != nil {
		return fmt.Errorf("report ready: %w", err)
	}

	w.logger.Info("ZIP job ready", "jobId", jobID, "parts", len(parts), "totalSize", totalSize)
	return nil
}

// createZip streams each file into a zip archive, splitting into ~2GB parts.
func (w *Worker) createZip(ctx context.Context, jobID string, entries []*pb.ZipEntry) ([]*pb.ZipPart, int64, error) {
	var parts []*pb.ZipPart
	partIndex := 0
	var totalSize int64

	seenPaths := make(map[string]bool)
	processed := int32(0)

	// part state
	var pw *partWriter
	openPart := func() error {
		key := fmt.Sprintf("zip/%s/part%03d.zip", jobID, partIndex)
		p, err := newPartWriter(w.tempStorage, key)
		if err != nil {
			return err
		}
		pw = p
		return nil
	}
	closePart := func() error {
		if pw == nil {
			return nil
		}
		size, err := pw.Close()
		if err != nil {
			return err
		}
		parts = append(parts, &pb.ZipPart{
			Key:   pw.key,
			Size:  size,
			Index: int32(partIndex),
		})
		totalSize += size
		pw = nil
		return nil
	}

	if err := openPart(); err != nil {
		return nil, 0, err
	}

	for _, entry := range entries {
		// Split when the current archive is non-empty and would exceed PartSize.
		if pw.Written() > 0 && pw.Written()+entry.Size > PartSize {
			if err := closePart(); err != nil {
				return nil, 0, err
			}
			partIndex++
			if err := openPart(); err != nil {
				return nil, 0, err
			}
		}

		relPath := uniquePath(entry.RelativePath, seenPaths)

		if err := w.appendFile(ctx, pw.zw, relPath, entry.FileRecordId); err != nil {
			// Skip unreadable files rather than failing the whole archive.
			w.logger.Warn("Skipping file in ZIP", "jobId", jobID, "fileId", entry.FileRecordId, "path", entry.RelativePath, "error", err)
		}

		processed++
		if err := w.client.ReportZipProgress(ctx, jobID, processed); err != nil {
			w.logger.Debug("Failed to report ZIP progress", "jobId", jobID, "error", err)
		}
	}

	if err := closePart(); err != nil {
		return nil, 0, err
	}

	return parts, totalSize, nil
}

func (w *Worker) appendFile(ctx context.Context, zw *zip.Writer, relPath, fileID string) error {
	meta, err := w.client.GetFileMetadata(ctx, fileID)
	if err != nil {
		return fmt.Errorf("metadata: %w", err)
	}

	info, err := w.downloader.GetDownloadInfo(meta)
	if err != nil {
		return fmt.Errorf("download info: %w", err)
	}

	fw, err := zw.Create(relPath)
	if err != nil {
		return fmt.Errorf("zip create entry: %w", err)
	}

	return w.downloader.StreamFullFile(ctx, fw, info)
}

func (w *Worker) cleanup(jobID string) {
	// Best-effort removal of any partial parts already written.
	for i := 0; i < 256; i++ {
		key := fmt.Sprintf("zip/%s/part%03d.zip", jobID, i)
		if !w.tempStorage.Exists(key) {
			break
		}
		_ = w.tempStorage.Delete(key)
	}
}

// uniquePath ensures relative paths are unique within the archive.
func uniquePath(relPath string, seen map[string]bool) string {
	if !seen[relPath] {
		seen[relPath] = true
		return relPath
	}

	dir := path.Dir(relPath)
	base := path.Base(relPath)
	ext := path.Ext(base)
	name := strings.TrimSuffix(base, ext)

	counter := 1
	for {
		var candidate string
		if dir == "." || dir == "" {
			candidate = fmt.Sprintf("%s_%d%s", name, counter, ext)
		} else {
			candidate = fmt.Sprintf("%s/%s_%d%s", dir, name, counter, ext)
		}
		if !seen[candidate] {
			seen[candidate] = true
			return candidate
		}
		counter++
	}
}
