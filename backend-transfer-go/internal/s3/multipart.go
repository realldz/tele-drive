package s3

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/queue"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
	"gorm.io/gorm"
)

type PartInfo struct {
	PartNumber   int
	Size         int64
	ETag         string
	LastModified time.Time
}

type S3MultipartService struct {
	database      *db.DB
	telegram      *telegram.TelegramClient
	cryptoEngine  *crypto.CryptoEngine
	s3Service     *S3Service
	tempStorage   *storage.TempStorage
	bullClient    *queue.BullMQClient
	settingsCache *db.SettingsCache
}

func NewS3MultipartService(
	database *db.DB,
	telegram *telegram.TelegramClient,
	cryptoEngine *crypto.CryptoEngine,
	s3Service *S3Service,
	tempStorage *storage.TempStorage,
	bullClient *queue.BullMQClient,
	settingsCache *db.SettingsCache,
) *S3MultipartService {
	return &S3MultipartService{
		database:      database,
		telegram:      telegram,
		cryptoEngine:  cryptoEngine,
		s3Service:     s3Service,
		tempStorage:   tempStorage,
		bullClient:    bullClient,
		settingsCache: settingsCache,
	}
}

func (s *S3MultipartService) shouldBuffer(size int64) bool {
	maxSize := s.settingsCache.GetCachedSettingInt64("MAX_BUFFER_FILE_SIZE", 52428800)
	if size > maxSize {
		return false
	}
	usedBytes, err := s.tempStorage.GetUsedBytes()
	if err != nil {
		return false
	}
	maxDiskMb := s.settingsCache.GetCachedSettingInt64("MAX_BUFFER_DISK_MB", 2048)
	maxBytes := maxDiskMb * 1024 * 1024
	threshold := int64(float64(maxBytes) * 0.8)
	if usedBytes >= threshold {
		return false
	}
	return true
}

func (s *S3MultipartService) CreateMultipartUpload(ctx context.Context, userID string, bucket string, key string, contentType string) (string, error) {
	filename := key
	if lastSlash := strings.LastIndex(key, "/"); lastSlash != -1 {
		filename = key[lastSlash+1:]
	}

	folderID, _, err := s.s3Service.ResolveKey(userID, bucket, key, true)
	if err != nil {
		return "", err
	}

	dek, err := s.cryptoEngine.GenerateFileKey()
	if err != nil {
		return "", err
	}

	iv, err := s.cryptoEngine.GenerateIv()
	if err != nil {
		return "", err
	}

	encryptedKey, err := s.cryptoEngine.EncryptKey(dek)
	if err != nil {
		return "", err
	}

	ivHex := hex.EncodeToString(iv)

	record := db.FileRecord{
		ID:             generateUUID(),
		Filename:       filename,
		Size:           0,
		MimeType:       contentType,
		IsChunked:      true,
		TotalChunks:    10000, // sentinel total chunks
		Status:         "uploading",
		IsEncrypted:    true,
		EncryptionAlgo: stringAddr("aes-256-ctr"),
		EncryptionIv:   &ivHex,
		EncryptedKey:   &encryptedKey,
		FolderID:       folderID,
		UserID:         userID,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	if err := s.database.Create(&record).Error; err != nil {
		return "", err
	}

	return record.ID, nil
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

func (s *S3MultipartService) UploadPart(ctx context.Context, uploadID string, partNumber int, userID string, req io.Reader, contentLength int64) (string, int64, error) {
	chunkIndex := partNumber - 1

	if partNumber < 1 || partNumber > 10000 {
		return "", 0, errors.New("Invalid part number. Must be 1-10000.")
	}

	var fileRecord db.FileRecord
	if err := s.database.Where("id = ? AND \"userId\" = ? AND status = 'uploading'", uploadID, userID).First(&fileRecord).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", 0, fmt.Errorf("Upload not found or already completed: uploadId=%s", uploadID)
		}
		return "", 0, err
	}

	// Idempotency check
	var existing db.FileChunk
	err := s.database.Where("\"fileId\" = ? AND \"chunkIndex\" = ?", uploadID, chunkIndex).First(&existing).Error
	if err == nil {
		// Chunk already exists, return stored ETag
		etagStr := ""
		if existing.Etag != nil {
			etagStr = *existing.Etag
		} else {
			h := md5.New()
			h.Write([]byte(fmt.Sprintf("%d", chunkIndex)))
			etagStr = `"` + hex.EncodeToString(h.Sum(nil)) + `"`
		}
		return etagStr, int64(existing.Size), nil
	}

	if s.shouldBuffer(contentLength) {
		storageKey := fmt.Sprintf("chunk/%s/%d.tmp", uploadID, chunkIndex)
		hash := md5.New()
		counter := &countingWriter{w: hash}
		teeReader := io.TeeReader(req, counter)

		_, err := s.tempStorage.Write(storageKey, teeReader)
		if err == nil {
			etag := fmt.Sprintf("\"%s\"", hex.EncodeToString(hash.Sum(nil)))

			var encryptionIv *string
			if fileRecord.IsEncrypted && fileRecord.EncryptedKey != nil {
				ivBytes, _ := s.cryptoEngine.GenerateIv()
				ivStr := hex.EncodeToString(ivBytes)
				encryptionIv = &ivStr
			}

			chunk := db.FileChunk{
				ID:             generateUUID(),
				FileID:         uploadID,
				ChunkIndex:     chunkIndex,
				Size:           int(counter.count),
				TelegramFileID: nil,
				TempStorageKey: &storageKey,
				Status:         "buffered",
				EncryptionIv:   encryptionIv,
				Etag:           &etag,
				CreatedAt:      time.Now(),
			}

			if err := s.database.Create(&chunk).Error; err == nil {
				// Enqueue upload job
				jobData := map[string]interface{}{
					"type":           "chunk",
					"chunkId":        chunk.ID,
					"fileRecordId":   uploadID,
					"chunkIndex":     chunkIndex,
					"tempStorageKey": storageKey,
					"userId":         userID,
				}
				maxRetries := s.settingsCache.GetCachedSettingInt("BUFFER_MAX_RETRIES", 3)
				if err := s.bullClient.AddJob(ctx, "upload-dispatch", "dispatch-chunk", fmt.Sprintf("chunk-%s", chunk.ID), jobData, maxRetries); err != nil {
					slog.Warn("AddJob failed for S3 multipart buffered chunk", "chunkId", chunk.ID, "uploadId", uploadID, "error", err)
				}

				return etag, counter.count, nil
			}
		}
	}

	// Direct upload path
	dek, err := s.cryptoEngine.DecryptKey(*fileRecord.EncryptedKey)
	if err != nil {
		return "", 0, err
	}

	ivBytes, err := s.cryptoEngine.GenerateIv()
	if err != nil {
		return "", 0, err
	}

	hash := md5.New()
	counter := &countingWriter{w: hash}
	teeReader := io.TeeReader(req, counter)

	encryptedStream, err := s.cryptoEngine.EncryptStream(teeReader, dek, ivBytes)
	if err != nil {
		return "", 0, err
	}

	chunkFilename := fmt.Sprintf("%s.part%04d", fileRecord.ID, chunkIndex)
	telegramFileID, telegramMessageID, botID, err := s.telegram.UploadFile(ctx, encryptedStream, chunkFilename, contentLength)
	if err != nil {
		return "", 0, err
	}

	partMd5Hex := hex.EncodeToString(hash.Sum(nil))
	etag := fmt.Sprintf("\"%s\"", partMd5Hex)
	ivStr := hex.EncodeToString(ivBytes)

	chunk := db.FileChunk{
		ID:                generateUUID(),
		FileID:            uploadID,
		ChunkIndex:        chunkIndex,
		Size:              int(counter.count),
		TelegramFileID:    &telegramFileID,
		TelegramMessageID: intAddr(telegramMessageID),
		BotID:             botID,
		EncryptionIv:      &ivStr,
		Etag:              &etag,
		Status:            "complete",
		CreatedAt:         time.Now(),
	}

	if err := s.database.Create(&chunk).Error; err != nil {
		return "", 0, err
	}

	return etag, counter.count, nil
}

func (s *S3MultipartService) CompleteMultipartUpload(ctx context.Context, uploadID string, userID string, bucket string, key string, declaredPartCount int) (string, string, error) {
	var fileRecord db.FileRecord
	err := s.database.Where("id = ? AND \"userId\" = ?", uploadID, userID).Preload("Chunks").First(&fileRecord).Error
	if err != nil {
		return "", "", fmt.Errorf("Upload not found: uploadId=%s", uploadID)
	}

	// Idempotent check
	if fileRecord.Status == "complete" {
		etagStr := ""
		if fileRecord.Etag != nil {
			etagStr = *fileRecord.Etag
		} else {
			etagStr = `"` + uploadID + `"`
		}
		return fmt.Sprintf("/%s", uploadID), etagStr, nil
	}

	// Sort chunks by index
	var chunks []db.FileChunk
	if err := s.database.Where("\"fileId\" = ?", uploadID).Order("\"chunkIndex\" ASC").Find(&chunks).Error; err != nil {
		return "", "", err
	}

	uploadedCount := len(chunks)
	if uploadedCount < declaredPartCount {
		return "", "", fmt.Errorf("Missing parts: uploaded %d/%d", uploadedCount, declaredPartCount)
	}

	// Calculate total size and concatenated MD5 buffer
	var totalSize int64
	var partMd5Bytes []byte
	for _, c := range chunks {
		totalSize += int64(c.Size)
		hexMd5 := ""
		if c.Etag != nil {
			hexMd5 = strings.ReplaceAll(*c.Etag, "\"", "")
		}

		if len(hexMd5) != 32 {
			h := md5.New()
			h.Write([]byte(fmt.Sprintf("%d", c.ChunkIndex)))
			partMd5Bytes = append(partMd5Bytes, h.Sum(nil)...)
		} else {
			rawBytes, _ := hex.DecodeString(hexMd5)
			partMd5Bytes = append(partMd5Bytes, rawBytes...)
		}
	}

	concatMd5 := md5.Sum(partMd5Bytes)
	finalEtag := fmt.Sprintf("\"%s-%d\"", hex.EncodeToString(concatMd5[:]), uploadedCount)

	existingRecords, err := s.s3Service.FindObjectRecords(userID, bucket, key)
	if err != nil {
		return "", "", err
	}

	var replacedRecordIDs []string
	for _, rec := range existingRecords {
		if rec.ID != uploadID {
			replacedRecordIDs = append(replacedRecordIDs, rec.ID)
		}
	}

	// Count how many parts were already dispatched by the worker
	var accountedSize int64
	for _, c := range chunks {
		if c.TelegramFileID != nil && *c.TelegramFileID != "" {
			accountedSize += int64(c.Size)
		}
	}
	remainingSize := totalSize - accountedSize

	err = s.database.Transaction(func(tx *gorm.DB) error {
		// Update FileRecord
		if err := tx.Model(&db.FileRecord{}).Where("id = ?", uploadID).Updates(map[string]interface{}{
			"status":      "complete",
			"totalChunks": uploadedCount,
			"size":        totalSize,
			"etag":        finalEtag,
			"updatedAt":   time.Now(),
		}).Error; err != nil {
			return err
		}

		// Update User usedSpace (only for unaccounted size)
		if remainingSize > 0 {
			if err := tx.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr(db.ColUsedSpace+" + ?", remainingSize)).Error; err != nil {
				return err
			}
		}

		// Soft delete replaced records
		if len(replacedRecordIDs) > 0 {
			now := time.Now()
			if err := tx.Model(&db.FileRecord{}).Where("id IN ?", replacedRecordIDs).Update(db.ColDeletedAt, &now).Error; err != nil {
				return err
			}
		}

		return nil
	})

	if err != nil {
		return "", "", err
	}

	return fmt.Sprintf("/%s", uploadID), finalEtag, nil
}

func (s *S3MultipartService) AbortMultipartUpload(ctx context.Context, uploadID string, userID string) error {
	var fileRecord db.FileRecord
	err := s.database.Where("id = ? AND \"userId\" = ?", uploadID, userID).First(&fileRecord).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil // already gone, idempotent
		}
		return err
	}

	if fileRecord.Status == "complete" {
		return errors.New("Cannot abort a completed upload. Use DeleteObject instead.")
	}

	var chunks []db.FileChunk
	if err := s.database.Where("\"fileId\" = ?", uploadID).Find(&chunks).Error; err == nil {
		for _, chunk := range chunks {
			if chunk.TelegramMessageID != nil {
				_ = s.telegram.DeleteMessage(ctx, *chunk.TelegramMessageID, chunk.BotID)
			}
		}
	}

	// Delete FileRecord (cascades to chunks in DB)
	return s.database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("\"fileId\" = ?", uploadID).Delete(&db.FileChunk{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", uploadID).Delete(&db.FileRecord{}).Error
	})
}

func (s *S3MultipartService) ListParts(ctx context.Context, uploadID string, userID string) ([]PartInfo, error) {
	var fileRecord db.FileRecord
	err := s.database.Where("id = ? AND \"userId\" = ?", uploadID, userID).First(&fileRecord).Error
	if err != nil {
		return nil, fmt.Errorf("Upload not found: uploadId=%s", uploadID)
	}

	var chunks []db.FileChunk
	if err := s.database.Where("\"fileId\" = ?", uploadID).Order("\"chunkIndex\" ASC").Find(&chunks).Error; err != nil {
		return nil, err
	}

	var parts []PartInfo
	for _, c := range chunks {
		etagStr := ""
		if c.Etag != nil {
			etagStr = *c.Etag
		} else {
			h := md5.New()
			h.Write([]byte(fmt.Sprintf("%d", c.ChunkIndex)))
			etagStr = `"` + hex.EncodeToString(h.Sum(nil)) + `"`
		}

		parts = append(parts, PartInfo{
			PartNumber:   c.ChunkIndex + 1,
			Size:         int64(c.Size),
			ETag:         etagStr,
			LastModified: c.CreatedAt,
		})
	}

	return parts, nil
}

// Helper addresses
func stringAddr(s string) *string {
	return &s
}

func intAddr(i int) *int {
	return &i
}
