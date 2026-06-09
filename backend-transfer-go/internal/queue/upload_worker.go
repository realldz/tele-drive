package queue

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
	"gorm.io/gorm"
)

type UploadWorker struct {
	database       *db.DB
	telegramClient *telegram.TelegramClient
	cryptoEngine   *crypto.CryptoEngine
	tempStorage    *storage.TempStorage
	settingsCache  *db.SettingsCache
	logger         *slog.Logger
}

func NewUploadWorker(
	database *db.DB,
	telegramClient *telegram.TelegramClient,
	cryptoEngine *crypto.CryptoEngine,
	tempStorage *storage.TempStorage,
	settingsCache *db.SettingsCache,
	logger *slog.Logger,
) *UploadWorker {
	return &UploadWorker{
		database:       database,
		telegramClient: telegramClient,
		cryptoEngine:   cryptoEngine,
		tempStorage:    tempStorage,
		settingsCache:  settingsCache,
		logger:         logger,
	}
}

type countingWriter struct {
	w     io.Writer
	count int64
}

func (cw *countingWriter) Write(p []byte) (n int, err error) {
	n, err = cw.w.Write(p)
	cw.count += int64(n)
	return n, err
}

func (uw *UploadWorker) ProcessJob(ctx context.Context, job *Job) (err error) {
	defer func() {
		if err != nil {
			uw.handleJobFailure(job, err)
		}
	}()

	var payload struct {
		Type           string `json:"type"`
		RecordID       string `json:"recordId"`
		ChunkID        string `json:"chunkId"`
		FileRecordID   string `json:"fileRecordId"`
		ChunkIndex     int    `json:"chunkIndex"`
		TempStorageKey string `json:"tempStorageKey"`
		UserID         string `json:"userId"`
	}
	if err := json.Unmarshal([]byte(job.Data), &payload); err != nil {
		return err
	}

	if payload.Type == "file" {
		return uw.processFile(ctx, payload.RecordID, payload.TempStorageKey, payload.UserID)
	} else if payload.Type == "chunk" {
		return uw.processChunk(ctx, payload.ChunkID, payload.FileRecordID, payload.ChunkIndex, payload.TempStorageKey, payload.UserID)
	}

	return fmt.Errorf("unknown upload job type: %s", payload.Type)
}

func (uw *UploadWorker) processFile(ctx context.Context, recordID, tempStorageKey, userID string) error {
	var record db.FileRecord
	if err := uw.database.Where("id = ?", recordID).First(&record).Error; err != nil {
		uw.logger.Warn("File record not found. Skipping.", "recordId", recordID)
		return nil
	}

	if record.TelegramFileID != nil && *record.TelegramFileID != "" {
		uw.logger.Info("File already has TelegramFileID. Skipping.", "recordId", recordID)
		return nil
	}

	src, err := uw.tempStorage.Read(tempStorageKey)
	if err != nil {
		return err
	}
	defer src.Close()

	dek, err := uw.cryptoEngine.GenerateFileKey()
	if err != nil {
		return err
	}
	iv, err := uw.cryptoEngine.GenerateIv()
	if err != nil {
		return err
	}
	encryptedKey, err := uw.cryptoEngine.EncryptKey(dek)
	if err != nil {
		return err
	}

	hash := md5.New()
	counter := &countingWriter{w: hash}
	tee := io.TeeReader(src, counter)
	encryptedStream, err := uw.cryptoEngine.EncryptStream(tee, dek, iv)
	if err != nil {
		return err
	}

	telegramFileID, telegramMessageID, botID, err := uw.telegramClient.UploadFile(ctx, encryptedStream, record.Filename, record.Size)
	if err != nil {
		return err
	}

	md5Hex := hex.EncodeToString(hash.Sum(nil))
	etag := fmt.Sprintf("\"%s\"", md5Hex)

	err = uw.database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&db.FileRecord{}).Where("id = ?", record.ID).Updates(map[string]interface{}{
			"status":            "complete",
			"telegramFileId":    telegramFileID,
			"telegramMessageId": telegramMessageID,
			"botId":             botID,
			"isEncrypted":       true,
			"encryptionAlgo":    "aes-256-ctr",
			"encryptionIv":      hex.EncodeToString(iv),
			"encryptedKey":      encryptedKey,
			"tempStorageKey":    nil,
			"etag":              etag,
		}).Error; err != nil {
			return err
		}

		return tx.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr("\"usedSpace\" + ?", record.Size)).Error
	})

	if err == nil {
		_ = uw.tempStorage.Delete(tempStorageKey)
		uw.logger.Info("File dispatched successfully", "filename", record.Filename, "size", record.Size, "botId", botID)
	}

	return err
}

func (uw *UploadWorker) processChunk(ctx context.Context, chunkID, fileRecordID string, chunkIndex int, tempStorageKey, userID string) error {
	var chunk db.FileChunk
	if err := uw.database.Where("id = ?", chunkID).First(&chunk).Error; err != nil {
		uw.logger.Warn("Chunk not found. Skipping.", "chunkId", chunkID)
		return nil
	}

	if chunk.Status == "complete" {
		uw.logger.Info("Chunk is already complete. Skipping.", "chunkId", chunkID)
		return nil
	}

	if chunk.Status != "buffered" {
		uw.logger.Warn("Chunk status mismatch", "chunkId", chunkID, "status", chunk.Status)
		return nil
	}

	var fileRecord db.FileRecord
	if err := uw.database.Where("id = ?", fileRecordID).First(&fileRecord).Error; err != nil {
		return err
	}

	dek, err := uw.cryptoEngine.DecryptKey(*fileRecord.EncryptedKey)
	if err != nil {
		return err
	}

	var ivBytes []byte
	if chunk.EncryptionIv != nil {
		ivBytes, _ = hex.DecodeString(*chunk.EncryptionIv)
	} else {
		ivBytes, _ = uw.cryptoEngine.GenerateIv()
	}

	src, err := uw.tempStorage.Read(tempStorageKey)
	if err != nil {
		return err
	}
	defer src.Close()

	hash := md5.New()
	counter := &countingWriter{w: hash}
	tee := io.TeeReader(src, counter)

	var encryptedStream io.Reader = tee
	if fileRecord.IsEncrypted && fileRecord.EncryptedKey != nil {
		encryptedStream, err = uw.cryptoEngine.EncryptStream(tee, dek, ivBytes)
		if err != nil {
			return err
		}
	}

	partFilename := fmt.Sprintf("%s.part%03d", fileRecordID, chunkIndex)
	telegramFileID, telegramMessageID, botID, err := uw.telegramClient.UploadFile(ctx, encryptedStream, partFilename, int64(chunk.Size))
	if err != nil {
		return err
	}

	md5Hex := hex.EncodeToString(hash.Sum(nil))
	etag := fmt.Sprintf("\"%s\"", md5Hex)
	ivStr := hex.EncodeToString(ivBytes)

	err = uw.database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&db.FileChunk{}).Where("id = ?", chunk.ID).Updates(map[string]interface{}{
			"status":            "complete",
			"telegramFileId":    telegramFileID,
			"telegramMessageId": telegramMessageID,
			"botId":             botID,
			"encryptionIv":      ivStr,
			"tempStorageKey":    nil,
			"etag":              etag,
		}).Error; err != nil {
			return err
		}

		// Increment quota for this chunk
		if err := tx.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr(db.ColUsedSpace+" + ?", int64(chunk.Size))).Error; err != nil {
			return err
		}

		// Check if this is the last buffered chunk for this file
		var pendingChunksCount int64
		if err := tx.Model(&db.FileChunk{}).Where("\"fileId\" = ? AND status = ?", fileRecordID, "buffered").Count(&pendingChunksCount).Error; err != nil {
			return err
		}

		if pendingChunksCount == 0 {
			// Only set to complete if CompleteUpload hasn't already done so
			var currentRecord db.FileRecord
			if err := tx.Where("id = ?", fileRecordID).First(&currentRecord).Error; err != nil {
				return err
			}
			if currentRecord.Status != "complete" {
				if err := tx.Model(&db.FileRecord{}).Where("id = ?", fileRecordID).Update("status", "complete").Error; err != nil {
					return err
				}
				uw.logger.Info("Chunked file fully complete", "filename", fileRecord.Filename, "size", fileRecord.Size)
			}
		}

		return nil
	})

	if err == nil {
		_ = uw.tempStorage.Delete(tempStorageKey)
		uw.logger.Info("Chunk dispatched successfully", "chunkIndex", chunkIndex, "fileId", fileRecordID, "botId", botID)
	}

	return err
}

func (uw *UploadWorker) handleJobFailure(job *Job, err error) {
	var payload struct {
		Type         string `json:"type"`
		RecordID     string `json:"recordId"`
		FileRecordID string `json:"fileRecordId"`
	}
	_ = json.Unmarshal([]byte(job.Data), &payload)

	var recordID string
	if payload.Type == "file" {
		recordID = payload.RecordID
	} else {
		recordID = payload.FileRecordID
	}

	if recordID == "" {
		return
	}

	attemptsMade := job.Processed + 1
	isFinalAttempt := attemptsMade >= job.Attempts

	if isFinalAttempt {
		_ = uw.database.Model(&db.FileRecord{}).Where("id = ?", recordID).Updates(map[string]interface{}{
			"status":        "buffer_failed",
			"bufferRetries": attemptsMade,
		}).Error
		uw.logger.Error("Upload job permanently failed", "recordId", recordID, "attempts", attemptsMade, "error", err)
	} else {
		_ = uw.database.Model(&db.FileRecord{}).Where("id = ?", recordID).Update(db.ColBufferRetries, attemptsMade).Error
		uw.logger.Warn("Upload job attempt failed, will retry", "recordId", recordID, "attempt", attemptsMade, "maxAttempts", job.Attempts, "error", err)
	}
}
