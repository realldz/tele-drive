package queue

import (
	"archive/zip"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
)

const PART_SIZE = 2 * 1024 * 1024 * 1024 // 2GB

type ZipWorker struct {
	database       *db.DB
	telegramClient *telegram.TelegramClient
	cryptoEngine   *crypto.CryptoEngine
	tempStorage    *storage.TempStorage
	logger         *slog.Logger
	httpClient     *http.Client
}

func NewZipWorker(
	database *db.DB,
	telegramClient *telegram.TelegramClient,
	cryptoEngine *crypto.CryptoEngine,
	tempStorage *storage.TempStorage,
	logger *slog.Logger,
) *ZipWorker {
	return &ZipWorker{
		database:       database,
		telegramClient: telegramClient,
		cryptoEngine:   cryptoEngine,
		tempStorage:    tempStorage,
		logger:         logger,
		httpClient: &http.Client{
			Timeout: 10 * time.Minute,
		},
	}
}

type FileEntry struct {
	FileRecordID string
	RelativePath string
	Size         int64
}

type ZipPartData struct {
	Key   string `json:"key"`
	Size  int64  `json:"size"`
	Index int    `json:"index"`
}

func (zw *ZipWorker) ProcessJob(ctx context.Context, job *Job) error {
	var payload struct {
		JobID string `json:"jobId"`
	}
	if err := json.Unmarshal([]byte(job.Data), &payload); err != nil {
		return err
	}

	jobID := payload.JobID

	// 1. Transition to collecting
	_ = zw.updateStatus(jobID, "collecting")

	entries, err := zw.collectFiles(jobID)
	if err != nil {
		zw.handleZipFailure(jobID, err)
		return err
	}

	var totalSize int64
	for _, e := range entries {
		totalSize += e.Size
	}

	_ = zw.database.Model(&db.DownloadJob{}).Where("id = ?", jobID).Updates(map[string]interface{}{
		"totalFiles": len(entries),
		"totalSize":  totalSize,
	})

	if len(entries) == 0 {
		err := errors.New("No files to download")
		zw.handleZipFailure(jobID, err)
		return err
	}

	// 2. Transition to zipping
	_ = zw.updateStatus(jobID, "zipping")

	zipParts, err := zw.createZip(ctx, jobID, entries)
	if err != nil {
		zw.handleZipFailure(jobID, err)
		return err
	}

	// 3. Mark ready
	partsJSON, _ := json.Marshal(zipParts)
	expiresAt := time.Now().Add(30 * time.Minute)

	err = zw.database.Model(&db.DownloadJob{}).Where("id = ?", jobID).Updates(map[string]interface{}{
		"status":    "ready",
		"zipParts":  string(partsJSON),
		"expiresAt": expiresAt,
	}).Error

	if err != nil {
		zw.handleZipFailure(jobID, err)
		return err
	}

	zw.logger.Info("ZIP job ready", "jobId", jobID, "files", len(entries), "parts", len(zipParts), "totalSize", totalSize)
	return nil
}

func (zw *ZipWorker) updateStatus(jobID string, status string) error {
	return zw.database.Model(&db.DownloadJob{}).Where("id = ?", jobID).Update("status", status).Error
}

func (zw *ZipWorker) handleZipFailure(jobID string, err error) {
	zw.logger.Error("ZIP job failed", "jobId", jobID, "error", err)

	// Clean up storage zip directory
	// In Go, since files are written to tempStorage via keys, we will delete keys when expired.
	// But let's set job to failed in DB
	_ = zw.database.Model(&db.DownloadJob{}).Where("id = ?", jobID).Updates(map[string]interface{}{
		"status":       "failed",
		"errorMessage": err.Error(),
	})
}

func (zw *ZipWorker) collectFiles(jobID string) ([]FileEntry, error) {
	var jobRecord db.DownloadJob
	if err := zw.database.Where("id = ?", jobID).First(&jobRecord).Error; err != nil {
		return nil, err
	}

	var fileIDs []string
	if jobRecord.FileIDs != "" {
		_ = json.Unmarshal([]byte(jobRecord.FileIDs), &fileIDs)
	}

	var folderIDs []string
	if jobRecord.FolderIDs != "" {
		_ = json.Unmarshal([]byte(jobRecord.FolderIDs), &folderIDs)
	}

	var entries []FileEntry

	// Direct files
	if len(fileIDs) > 0 {
		var files []db.FileRecord
		if err := zw.database.Where("id IN ? AND \"deletedAt\" IS NULL AND status = ?", fileIDs, "complete").Find(&files).Error; err == nil {
			for _, f := range files {
				entries = append(entries, FileEntry{
					FileRecordID: f.ID,
					RelativePath: f.Filename,
					Size:         f.Size,
				})
			}
		}
	}

	// Recursive folders
	for _, folderID := range folderIDs {
		var folder db.Folder
		if err := zw.database.Where("id = ?", folderID).First(&folder).Error; err != nil {
			continue
		}
		zw.collectFolderRecursive(folderID, folder.Name, folder.UserID, &entries)
	}

	return entries, nil
}

func (zw *ZipWorker) collectFolderRecursive(folderID, currentPath, userID string, entries *[]FileEntry) {
	var files []db.FileRecord
	if err := zw.database.Where("\"folderId\" = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL AND status = ?", folderID, userID, "complete").Find(&files).Error; err == nil {
		for _, f := range files {
			*entries = append(*entries, FileEntry{
				FileRecordID: f.ID,
				RelativePath: currentPath + "/" + f.Filename,
				Size:         f.Size,
			})
		}
	}

	var subfolders []db.Folder
	if err := zw.database.Where("\"parentId\" = ? AND \"deletedAt\" IS NULL", folderID).Find(&subfolders).Error; err == nil {
		for _, sub := range subfolders {
			zw.collectFolderRecursive(sub.ID, currentPath+"/"+sub.Name, userID, entries)
		}
	}
}

type zipCountingWriter struct {
	w     io.WriteCloser
	count int64
}

func (zcw *zipCountingWriter) Write(p []byte) (int, error) {
	n, err := zcw.w.Write(p)
	zcw.count += int64(n)
	return n, err
}

func (zcw *zipCountingWriter) Close() error {
	return zcw.w.Close()
}

func (zw *ZipWorker) createZip(ctx context.Context, jobID string, entries []FileEntry) ([]ZipPartData, error) {
	var zipParts []ZipPartData
	currentPartIndex := 0

	pr, pw := io.Pipe()
	zcw := &zipCountingWriter{w: pw}
	zipWriter := zip.NewWriter(zcw)

	currentPartKey := fmt.Sprintf("zip/%s/part%03d.zip", jobID, currentPartIndex)

	// Start uploading part asynchronously
	uploadErrChan := make(chan error, 1)
	go func() {
		_, err := zw.tempStorage.Write(currentPartKey, pr)
		uploadErrChan <- err
	}()

	processed := 0
	seenPaths := make(map[string]bool)

	for _, entry := range entries {
		// Check if adding this file exceeds part size (and we already have files in the current zip)
		if zcw.count > 0 && zcw.count+entry.Size > PART_SIZE {
			// Finalize current zip
			_ = zipWriter.Close()
			_ = zcw.Close()
			_ = pr.Close()

			if err := <-uploadErrChan; err != nil {
				return nil, err
			}

			zipParts = append(zipParts, ZipPartData{
				Key:   currentPartKey,
				Size:  zcw.count,
				Index: currentPartIndex,
			})

			// Start new part
			currentPartIndex++
			pr, pw = io.Pipe()
			zcw = &zipCountingWriter{w: pw}
			zipWriter = zip.NewWriter(zcw)
			currentPartKey = fmt.Sprintf("zip/%s/part%03d.zip", jobID, currentPartIndex)

			go func() {
				_, err := zw.tempStorage.Write(currentPartKey, pr)
				uploadErrChan <- err
			}()
		}

		// Unique path resolving
		relPath := entry.RelativePath
		counter := 1
		base := path.Base(relPath)
		dir := path.Dir(relPath)
		ext := path.Ext(relPath)
		name := strings.TrimSuffix(base, ext)

		for seenPaths[relPath] {
			var newName string
			if dir == "." || dir == "" {
				newName = fmt.Sprintf("%s_%d%s", name, counter, ext)
			} else {
				newName = fmt.Sprintf("%s/%s_%d%s", dir, name, counter, ext)
			}
			relPath = newName
			counter++
		}
		seenPaths[relPath] = true

		// Add entry to Zip
		w, err := zipWriter.Create(relPath)
		if err != nil {
			return nil, err
		}

		err = zw.fetchAndWriteFileStream(ctx, entry.FileRecordID, w)
		if err != nil {
			zw.logger.Warn("Skipping zip entry due to fetch error", "fileId", entry.FileRecordID, "path", entry.RelativePath, "error", err)
			// We skip the file but continue zipping the rest
		}

		processed++
		_ = zw.database.Model(&db.DownloadJob{}).Where("id = ?", jobID).Update(db.ColProcessedFiles, processed)
	}

	// Finalize last part
	_ = zipWriter.Close()
	_ = zcw.Close()
	_ = pr.Close()

	if err := <-uploadErrChan; err != nil {
		return nil, err
	}

	zipParts = append(zipParts, ZipPartData{
		Key:   currentPartKey,
		Size:  zcw.count,
		Index: currentPartIndex,
	})

	return zipParts, nil
}

func (zw *ZipWorker) fetchAndWriteFileStream(ctx context.Context, fileID string, w io.Writer) error {
	var fileRecord db.FileRecord
	if err := zw.database.Where("id = ?", fileID).First(&fileRecord).Error; err != nil {
		return err
	}

	// 1. Buffered
	if fileRecord.Status == "buffered" && fileRecord.TempStorageKey != nil {
		src, err := zw.tempStorage.Read(*fileRecord.TempStorageKey)
		if err != nil {
			return err
		}
		defer src.Close()
		_, err = io.Copy(w, src)
		return err
	}

	var dek []byte
	var err error
	if fileRecord.IsEncrypted && fileRecord.EncryptedKey != nil {
		dek, err = zw.cryptoEngine.DecryptKey(*fileRecord.EncryptedKey)
		if err != nil {
			return err
		}
	}

	// 2. Single
	if !fileRecord.IsChunked && fileRecord.TelegramFileID != nil {
		url, err := zw.resolveFileLink(ctx, *fileRecord.TelegramFileID, fileRecord.BotID, fileRecord.TelegramMessageID)
		if err != nil {
			return err
		}

		resp, err := zw.httpClient.Get(url)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("bad telegram response: %d", resp.StatusCode)
		}

		var reader io.Reader = resp.Body
		if fileRecord.IsEncrypted && len(dek) > 0 && fileRecord.EncryptionIv != nil {
			ivBytes, _ := hex.DecodeString(*fileRecord.EncryptionIv)
			reader, err = zw.cryptoEngine.DecryptStreamWithOffset(resp.Body, dek, ivBytes, 0)
			if err != nil {
				return err
			}
		}

		_, err = io.Copy(w, reader)
		return err
	}

	// 3. Chunked
	var chunks []db.FileChunk
	if err := zw.database.Where("\"fileId\" = ?", fileRecord.ID).Order("\"chunkIndex\" ASC").Find(&chunks).Error; err != nil {
		return err
	}

	for _, chunk := range chunks {
		var chunkStream io.ReadCloser
		if chunk.Status == "buffered" && chunk.TempStorageKey != nil {
			chunkStream, err = zw.tempStorage.Read(*chunk.TempStorageKey)
			if err != nil {
				return err
			}
		} else if chunk.TelegramFileID != nil {
			url, err := zw.resolveFileLink(ctx, *chunk.TelegramFileID, chunk.BotID, chunk.TelegramMessageID)
			if err != nil {
				return err
			}

			resp, err := zw.httpClient.Get(url)
			if err != nil {
				return err
			}

			if resp.StatusCode != http.StatusOK {
				resp.Body.Close()
				return fmt.Errorf("bad telegram chunk response: %d", resp.StatusCode)
			}
			chunkStream = resp.Body
		} else {
			return fmt.Errorf("invalid chunk state for chunk %s", chunk.ID)
		}

		var reader io.Reader = chunkStream
		if chunk.Status != "buffered" && fileRecord.IsEncrypted && len(dek) > 0 && chunk.EncryptionIv != nil {
			ivBytes, _ := hex.DecodeString(*chunk.EncryptionIv)
			reader, err = zw.cryptoEngine.DecryptStreamWithOffset(chunkStream, dek, ivBytes, 0)
			if err != nil {
				chunkStream.Close()
				return err
			}
		}

		_, err = io.Copy(w, reader)
		chunkStream.Close()
		if err != nil {
			return err
		}
	}

	return nil
}

func (zw *ZipWorker) resolveFileLink(ctx context.Context, fileID string, botID int64, msgID *int) (string, error) {
	link, err := zw.telegramClient.GetFileLink(ctx, fileID, botID)
	if err == nil {
		return link, nil
	}

	if msgID == nil {
		return "", fmt.Errorf("bot %d unavailable and no messageID for recovery: %w", botID, err)
	}

	newFileID, newBotID, err := zw.telegramClient.RecoverFileID(ctx, *msgID)
	if err != nil {
		return "", fmt.Errorf("failed to recover fileID: %w", err)
	}

	// Update chunk/file details in bg
	go func() {
		_ = zw.database.Model(&db.FileRecord{}).Where("\"telegramFileId\" = ?", fileID).Updates(map[string]interface{}{
			"telegramFileId": newFileID,
			"botId":          newBotID,
		}).Error
	}()

	return zw.telegramClient.GetFileLink(ctx, newFileID, newBotID)
}
